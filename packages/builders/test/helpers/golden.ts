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
    '6b43a747b1ae4f2ff8925b159ce1b24e263b230fb9eb78be700a81b852e82719',
  'bitwarden-web@2026.10.1+cloud-us':
    '40eaed9c10b200eaae067de95c908ad8fa5313ac01f689f00dee4bed9b36bf39',
  'bitwarden-web@2026.10.1+cloud-eu':
    '33ea05523e1c7595b32d39179ff291951aa6f060cc8c23bea6e474d88c66afb7',
  'vaultwarden-web@2026.10.1+release':
    '4da7abfbf52dfd18cd966201b3a73a7e402342b5bcaa2c005868ce9cce232c29',
});
