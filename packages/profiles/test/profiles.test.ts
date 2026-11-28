import {describe, expect, it} from 'vitest';
import {
  matchPathGlob,
  matchUrlPattern,
  profileOrigins,
  type AppProfile,
  type CspDirectiveName,
} from '@intactwarden/core/schema/profile.ts';
import {
  APP_PROFILES,
  bitwardenWeb,
  OFFICIAL_ORIGINS,
  profileByApp,
  vaultwardenWeb,
} from '../index.ts';

function directive(p: AppProfile, name: string): string | undefined {
  return (p.csp_floor as Record<string, string>)[name];
}

// ---------------------------------------------------------------------------
// Invariants the type system cannot express.
// The profiles are typed constants, so these tests are their only validator; they run in CI and
// before a release (docs/release.md).
// ---------------------------------------------------------------------------

/**
 * Directives every profile's floor enforces: the vendor HTML has no inline
 * scripts or handlers, so these can never break a genuine build.
 */
const LAUNCH_FLOOR: readonly (readonly [CspDirectiveName, string])[] = [
  ['base-uri', "'self'"],
  ['script-src-attr', "'none'"],
];

type SourceKind = 'self' | 'none' | 'wasm' | 'blob' | 'https';
const DIRECTIVE_SOURCES: Readonly<Record<CspDirectiveName, readonly SourceKind[]>> = {
  'base-uri': ['self', 'none'],
  'script-src': ['self', 'wasm', 'https'],
  'script-src-attr': ['none'],
  'worker-src': ['self', 'blob', 'https'],
  'form-action': ['self', 'none'],
};
const HOST_SOURCE = /^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}(?:\/[A-Za-z0-9._~\-/]*)?$/;

function sourceKind(source: string): SourceKind | null {
  if (source === "'self'") return 'self';
  if (source === "'none'") return 'none';
  if (source === "'wasm-unsafe-eval'") return 'wasm';
  if (source === 'blob:') return 'blob';
  return HOST_SOURCE.test(source) ? 'https' : null;
}

/** A path glob: absolute, "*" inside segments, "**" only as the whole last segment. */
function globProblem(glob: string): string | null {
  if (glob === '/') return null;
  if (!/^\/(?:[A-Za-z0-9\-._~!$&'()+,;=:@|^/*]|%[0-9A-Fa-f]{2})*$/.test(glob)) return 'syntax';
  const segments = glob.slice(1).split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '' && i !== segments.length - 1) return 'empty segment';
    if (/^(?:\.|%2e){1,2}$/i.test(seg)) return 'dot segment';
    if (seg.includes('**') && (seg !== '**' || i !== segments.length - 1)) return '"**"';
  }
  return null;
}

function cspErrors(p: AppProfile): string[] {
  const errors: string[] = [];
  const at = (name: string) => `${p.app} csp_floor.${name}`;
  for (const [name, value] of LAUNCH_FLOOR) {
    if (p.csp_floor[name] !== value)
      errors.push(`${at(name)} must enforce ${value} (launch floor)`);
  }
  const checked = (where: string, name: CspDirectiveName, list: readonly string[]): Set<string> => {
    const set = new Set(list);
    if (set.size !== list.length) errors.push(`${where} repeats a source`);
    for (const s of set) {
      const kind = sourceKind(s);
      if (kind === null || !DIRECTIVE_SOURCES[name].includes(kind))
        errors.push(`${where}: source ${s} is not allowed`);
    }
    if (set.has("'none'") && set.size > 1) errors.push(`${where}: 'none' must stand alone`);
    return set;
  };
  for (const [name, value] of Object.entries(p.csp_floor) as [CspDirectiveName, string][]) {
    const floor = checked(at(name), name, value.split(' '));
    // A payment script is never in the floor: only the one document the user allows it for gets
    // its sources.
    for (const t of p.third_party) {
      for (const s of t.csp_allowance?.[name] ?? []) {
        if (floor.has(s)) errors.push(`${at(name)}: ${s} is a third-party allowance (${t.id})`);
      }
    }
  }
  for (const t of p.third_party) {
    if (t.csp_allowance !== undefined && t.kind !== 'unpinnable-script')
      errors.push(`${p.app} third_party ${t.id}: csp_allowance only for kind unpinnable-script`);
    for (const [name, list] of Object.entries(t.csp_allowance ?? {}) as [
      CspDirectiveName,
      readonly string[],
    ][]) {
      const where = `${p.app} third_party ${t.id} csp_allowance.${name}`;
      if (p.csp_floor[name] === undefined) errors.push(`${where}: the floor has no ${name}`);
      checked(where, name, list);
    }
  }
  return errors;
}

function profileErrors(p: AppProfile): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${p.app}: ${msg}`);
  const deploymentIds = new Set<string>();
  const used = new Set<string>();
  for (const d of p.deployments) {
    if (deploymentIds.has(d.id)) err(`duplicate deployment id ${d.id}`);
    deploymentIds.add(d.id);
    if ((d.kind === 'self-hosted') !== (d.origins === 'user'))
      err(`deployment ${d.id}: self-hosted deployments (and only they) use "user"`);
    if (p.variants[d.variant] === undefined)
      err(`deployment ${d.id}: unknown variant ${d.variant}`);
    used.add(d.variant);
    for (const r of d.server_rendered ?? []) if (globProblem(r.path)) err(`glob ${r.path}`);
  }
  const seen = new Set<string>();
  for (const {origin} of profileOrigins(p)) {
    if (seen.has(origin)) err(`origin ${origin} is listed twice`);
    seen.add(origin);
    if (new URL(origin).origin !== origin || !origin.startsWith('https://'))
      err(`origin ${origin} is not a canonical https origin`);
  }
  for (const id of Object.keys(p.variants))
    if (!used.has(id)) err(`variant ${id} is not used by any deployment`);
  for (const pattern of [p.upstream.tag_pattern, p.upstream.asset])
    if (pattern.split('{version}').length !== 2) err(`${pattern}: needs exactly one {version}`);
  const r = p.resources;
  for (const rule of [...r.dynamic_same_origin, ...r.not_covered_paths, ...(r.server_styles ?? [])])
    for (const d of rule.deployments ?? [])
      if (!deploymentIds.has(d)) err(`${rule.path}: unknown deployment ${d}`);
  const globs = [
    ...r.dynamic_same_origin.map(d => d.path),
    ...r.not_covered_paths.map(n => n.path),
    ...p.deployments.flatMap(d => (d.server_rendered ?? []).map(x => x.path)),
  ];
  for (const g of [...globs, ...(p.identify.documents ?? [])])
    if (globProblem(g) !== null) err(`glob ${g}: ${globProblem(g)}`);
  // A server stylesheet is classified by exactly one rule.
  const styles = new Set<string>();
  for (const style of r.server_styles ?? []) {
    if (style.path.endsWith('/') || style.path.includes('*'))
      err(`server style ${style.path} must be the exact path of a file`);
    if (styles.has(style.path)) err(`server style ${style.path} is listed twice`);
    styles.add(style.path);
    for (const g of globs)
      if (matchPathGlob(g, style.path)) err(`server style ${style.path} is also matched by ${g}`);
  }
  // A subresource redirect is allowed only on a dynamic path.
  for (const sr of p.headers?.subresource_redirects ?? []) {
    if (!r.dynamic_same_origin.some(d => d.path === sr.path))
      err(`subresource redirect ${sr.path} needs a dynamic_same_origin entry`);
  }
  const tpIds = new Set<string>();
  for (const t of p.third_party) {
    if (tpIds.has(t.id)) err(`duplicate third_party id ${t.id}`);
    tpIds.add(t.id);
  }
  return [...errors, ...cspErrors(p)];
}

/** Invariants across profiles: app ids are unique; no origin is claimed twice. */
function profileSetErrors(profiles: readonly AppProfile[]): string[] {
  const errors = profiles.flatMap(profileErrors);
  const apps = new Set<string>();
  for (const p of profiles) {
    if (apps.has(p.app)) errors.push(`duplicate app id ${p.app}`);
    apps.add(p.app);
  }
  const owner = new Map<string, string>();
  for (const p of profiles) {
    for (const {origin} of profileOrigins(p)) {
      const prev = owner.get(origin);
      if (prev !== undefined && prev !== p.app)
        errors.push(`${origin} (in ${p.app}) is already claimed by ${prev}`);
      else owner.set(origin, p.app);
    }
  }
  return errors;
}

describe('bundled profiles', () => {
  it('bundles exactly the supported profiles', () => {
    expect(APP_PROFILES.map(p => p.app).sort()).toEqual(['bitwarden-web', 'vaultwarden-web']);
  });

  it('hold every invariant the type system cannot express', () => {
    expect(profileSetErrors(APP_PROFILES)).toEqual([]);
  });

  it('the invariant check catches broken profiles', () => {
    const errorsOf = (p: AppProfile) => profileSetErrors([p]).join('\n');
    const withFloor = (b: object): AppProfile =>
      ({...bitwardenWeb, csp_floor: {...bitwardenWeb.csp_floor, ...b}}) as AppProfile;
    expect(errorsOf(withFloor({'base-uri': "'none'"}))).toContain('launch floor');
    expect(errorsOf(withFloor({'script-src': "'self' 'unsafe-inline'"}))).toContain(
      "source 'unsafe-inline' is not allowed",
    );
    expect(errorsOf(withFloor({'script-src': "'self' https://js.stripe.com"}))).toContain(
      'https://js.stripe.com is a third-party allowance (stripe)',
    );
    expect(
      errorsOf({
        ...bitwardenWeb,
        third_party: bitwardenWeb.third_party.map(t =>
          t.id === 'stripe' ? {...t, kind: 'data' as const} : t,
        ),
      }),
    ).toContain('csp_allowance only for kind unpinnable-script');
    expect(
      errorsOf({
        ...bitwardenWeb,
        variants: {...bitwardenWeb.variants, 'selfhosted-oss': {assurance: 'release-exact'}},
      }),
    ).toContain('variant selfhosted-oss is not used by any deployment');
    expect(
      errorsOf({...bitwardenWeb, upstream: {...bitwardenWeb.upstream, asset: 'web.zip'}}),
    ).toContain('web.zip: needs exactly one {version}');
    expect(
      errorsOf({
        ...vaultwardenWeb,
        headers: {subresource_redirects: [{path: '/img/**', types: ['image']}]},
      }),
    ).toContain('needs a dynamic_same_origin entry');
    expect(
      errorsOf({
        ...vaultwardenWeb,
        resources: {
          ...vaultwardenWeb.resources,
          dynamic_same_origin: [...vaultwardenWeb.resources.dynamic_same_origin, {path: '/css/**'}],
        },
      }),
    ).toContain('/css/vaultwarden.css is also matched by /css/**');
  });

  it('the invariant check catches broken profile sets', () => {
    const clash = {
      ...bitwardenWeb,
      app: 'bitwarden-web-copy',
      deployments: [bitwardenWeb.deployments[1]!],
    } as AppProfile;
    expect(profileSetErrors([...APP_PROFILES, clash]).join('\n')).toContain(
      'https://vault.bitwarden.eu (in bitwarden-web-copy) is already claimed by bitwarden-web',
    );
    expect(profileSetErrors([bitwardenWeb, bitwardenWeb]).join('\n')).toContain(
      'duplicate app id bitwarden-web',
    );
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(bitwardenWeb)).toBe(true);
    expect(Object.isFrozen(bitwardenWeb.deployments[0]!.origins)).toBe(true);
    expect(Object.isFrozen(vaultwardenWeb.resources.dynamic_same_origin[0])).toBe(true);
    expect(() => (OFFICIAL_ORIGINS as string[]).push('https://evil.example')).toThrow();
  });
});

describe('origins', () => {
  const all = APP_PROFILES.flatMap(p => profileOrigins(p).map(o => ({...o, app: p.app})));

  it('are canonical, lowercase https origins', () => {
    expect(all.length).toBe(2);
    for (const {origin} of all) {
      expect(origin).toBe(new URL(origin).origin);
      expect(origin.startsWith('https://')).toBe(true);
      expect(origin).toBe(origin.toLowerCase());
    }
  });

  it('the generated official-origin list is stable', () => {
    expect(OFFICIAL_ORIGINS).toEqual(['https://vault.bitwarden.com', 'https://vault.bitwarden.eu']);
  });
});

describe('profileByApp', () => {
  it('profileByApp()', () => {
    expect(profileByApp('bitwarden-web')).toBe(bitwardenWeb);
    expect(profileByApp('vaultwarden-web')).toBe(vaultwardenWeb);
    expect(profileByApp('other-app')).toBeUndefined();
    expect(profileByApp('__proto__')).toBeUndefined();
  });
});

describe('Bitwarden Web Vault profile', () => {
  it('has the cloud and self-hosted deployments', () => {
    expect(bitwardenWeb.deployments.map(d => [d.id, d.kind])).toEqual([
      ['cloud-us', 'cloud'],
      ['cloud-eu', 'cloud'],
      ['self-hosted', 'self-hosted'],
    ]);
    const self = bitwardenWeb.deployments[2]!;
    expect(self.origins).toBe('user');
    expect(self.server_rendered).toEqual([
      {path: '/admin/**', class: 'admin-portal'},
      {path: '/sso/**', class: 'auth-flow'},
      {path: '/identity/**', class: 'auth-flow'},
    ]);
  });

  it('builds every variant from the COMMERCIAL release; one variant per deployment', () => {
    expect(bitwardenWeb.variants).toEqual({
      'selfhosted-commercial': {assurance: 'release-exact'},
      'cloud-us': {assurance: 'release-derived'},
      'cloud-eu': {assurance: 'release-derived'},
    });
    expect(bitwardenWeb.deployments.map(d => [d.id, d.variant])).toEqual([
      ['cloud-us', 'cloud-us'],
      ['cloud-eu', 'cloud-eu'],
      ['self-hosted', 'selfhosted-commercial'],
    ]);
    expect(bitwardenWeb.upstream.asset).toBe('web-{version}-selfhosted-COMMERCIAL.zip');
    expect(bitwardenWeb.upstream.tag_pattern).toBe('web-v{version}');
  });

  it('allows billing scripts only as unpinnable scripts, admitted for one page load only', () => {
    const billing = bitwardenWeb.third_party.filter(t => t.kind === 'unpinnable-script');
    expect(billing.map(t => t.id)).toEqual(['stripe', 'braintree', 'paypal']);
    for (const t of billing) expect(t.csp_allowance?.['script-src']?.length).toBeGreaterThan(0);
    const match = (url: string): string | undefined =>
      bitwardenWeb.third_party.find(t => t.match.some(m => matchUrlPattern(m, url)))?.id;
    expect(match('https://js.stripe.com/v3/')).toBe('stripe');
    expect(match('https://js.braintreegateway.com/web/dropin/1.33.7/js/dropin.min.js')).toBe(
      'braintree',
    );
    expect(match('https://www.paypalobjects.com/api/checkout.min.js')).toBe('paypal');
    expect(match('https://api-12345678.duosecurity.com/frame/v4/auth')).toBe('duo');
    expect(match('https://evil.example/js.stripe.com/v3')).toBeUndefined();
  });

  it('CSP floor: enforced directives only', () => {
    expect(bitwardenWeb.csp_floor).toEqual({
      'base-uri': "'self'",
      'script-src-attr': "'none'",
      'script-src': "'self' 'wasm-unsafe-eval'",
    });
  });

  it('declares the server data paths, so they are never buffered as build files', () => {
    const r = bitwardenWeb.resources;
    const dynamic = (path: string) => r.dynamic_same_origin.find(d => matchPathGlob(d.path, path));
    // Attachment downloads and event uploads on a self-hosted server (inferred, not observed).
    for (const path of [
      '/attachments/c1/a1',
      '/events/collect',
      '/api/sync',
      '/notifications/hub',
    ]) {
      expect(dynamic(path), path).toBeDefined();
    }
    expect(dynamic('/app/main.e6e5863d81ffec268583.js')).toBeUndefined();
  });
});

describe('Vaultwarden Web Vault profile', () => {
  const self = vaultwardenWeb.deployments[0]!;

  it('verifies dani-garcia/bw_web_builds release tarballs (release-exact)', () => {
    expect(vaultwardenWeb.upstream).toEqual({
      repo: 'dani-garcia/bw_web_builds',
      repo_id: 161632059,
      tag_pattern: 'v{version}',
      asset: 'bw_web_v{version}.tar.gz',
      archive_root: 'web-vault/',
    });
    // Image-only releases have no release asset: BUILD_UNVERIFIED (image-only-release).
    expect(vaultwardenWeb.variants).toEqual({release: {assurance: 'release-exact'}});
  });

  it('has one self-hosted deployment, claiming no origin', () => {
    expect(vaultwardenWeb.deployments).toHaveLength(1);
    expect(self).toMatchObject({kind: 'self-hosted', origins: 'user'});
    expect(profileOrigins(vaultwardenWeb)).toEqual([]);
    expect(vaultwardenWeb.identify.hint_endpoints?.[0]).toBe('/vw-version.json');
    expect(self.server_rendered?.map(r => r.class)).toEqual([
      'admin-portal',
      'auth-flow',
      'auth-flow',
    ]);
  });

  it('classifies the server-generated paths', () => {
    const r = vaultwardenWeb.resources;
    const dynamic = (path: string) => r.dynamic_same_origin.find(d => matchPathGlob(d.path, path));
    for (const path of [
      '/api/config',
      '/identity/connect/token',
      '/notifications/hub',
      '/alive',
      '/icons/example.com/icon.png',
      '/app-id.json',
    ]) {
      expect(dynamic(path), path).toBeDefined();
    }
    expect(dynamic('/css/vaultwarden.css')).toBeUndefined();
    expect(r.server_styles).toEqual([{path: '/css/vaultwarden.css'}]);
    expect(r.not_covered_paths).toEqual([
      {path: '/vw_static/**', reason: 'server-embedded-admin-assets'},
    ]);
    expect(vaultwardenWeb.headers?.subresource_redirects).toEqual([
      {path: '/icons/**', types: ['image']},
    ]);
  });

  it('declares its document paths ("/index.html" is a 303 on Rocket)', () => {
    expect(vaultwardenWeb.identify.documents).toEqual(['/', '/*-connector.html', '/404.html']);
  });

  it('enforces the floor the stock server already enforces', () => {
    expect(directive(vaultwardenWeb, 'script-src')).toBe("'self' 'wasm-unsafe-eval'");
    expect(directive(vaultwardenWeb, 'worker-src')).toBe("'self'");
    expect(directive(vaultwardenWeb, 'form-action')).toBe("'self'");
    expect(directive(vaultwardenWeb, 'object-src')).toBeUndefined();
  });

  it('treats billing scripts as unexpected', () => {
    const billing = vaultwardenWeb.third_party.find(t => t.id === 'billing-scripts');
    expect(billing).toMatchObject({kind: 'unexpected'});
    expect(billing?.match.some(m => matchUrlPattern(m, 'https://js.stripe.com/v3/'))).toBe(true);
  });
});
