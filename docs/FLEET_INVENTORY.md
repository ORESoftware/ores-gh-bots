# Read-only fleet inventory

Run `npm run cli -- fleet inventory` with the existing orchestrator App runtime
credentials and `OWNER_ALLOWLIST` / `OWNER_PATTERNS` configuration. The command
uses the canonical flags2env command parser and performs no GitHub writes.

The output inventories repositories visible to that App. Both installation and
repository pagination must finish within the safety ceiling. An installation
that cannot be read is recorded as `uninspected`; suspended installations remain
visible. Explicit allowlisted owners with no admitted installation appear in
`missing_expected_owners`. Any such gap makes the command exit nonzero.

`enumeration_complete` describes only enumeration of the admitted App visibility.
It does not certify ownership coverage: `ownership_inventory_complete` is always
false, and each installation retains its `all` / `selected` repository selection.
Owner regexes cannot enumerate expected-but-missing organizations. Put owners
that must be covered in the explicit allowlist.

Archived, disabled and private repositories stay visible. Role, dependencies,
contract authorities, supported languages and release mechanism remain null
until a source-backed inspection establishes them; null does not mean none.
This first slice establishes visibility and classification gaps. It does not
claim that repository contents, cross-repo dependencies or deployment consumers
have already been audited.

Do not commit real inventory output to this public repository: it can contain
private repository names. Keep runtime credentials in the configured secret
boundary. Provider errors are classified without copying their text into output.
The existing `fleet discover --limit` behavior remains unchanged.
