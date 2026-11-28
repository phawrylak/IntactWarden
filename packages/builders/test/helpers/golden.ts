/**
 * Golden core digests of the corpus releases (fixtures/corpora/*.lock.json),
 * keyed by build id. A core is a pure function of its inputs, so every build of
 * these releases must produce these exact bytes;
 * update them only with a deliberate change of the core format or of the
 * builders' output, reviewed as such. They are shared by the builders' corpus
 * tests and the extension's bootstrap and deep-verify corpus tests, so every
 * path to a core is held to the same bytes.
 */

export const GOLDEN_CORES: Readonly<Record<string, string>> = Object.freeze({
  'bitwarden-web@2026.10.1+selfhosted-commercial':
    '69f3650f025800fd2be65a3d9ede40da7ea34621c2b97f5e2cb08ea836a0849f',
  'bitwarden-web@2026.10.1+cloud-us':
    '40eaed9c10b200eaae067de95c908ad8fa5313ac01f689f00dee4bed9b36bf39',
  'bitwarden-web@2026.10.1+cloud-eu':
    '33ea05523e1c7595b32d39179ff291951aa6f060cc8c23bea6e474d88c66afb7',
  'vaultwarden-web@2026.10.1+release':
    '2e297f6762a446de58fad3c1045bc042df5f25a183d36b482e309fee970a638a',
});
