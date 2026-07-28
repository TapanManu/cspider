## ADDED Requirements

### Requirement: Multi-PR ingestion
The system SHALL accept one or more GitHub pull request URLs and fetch, for each, the PR metadata, changed file list, unified diff, commit list, existing review threads, and CI status.

#### Scenario: Single PR ingested
- **WHEN** the reviewer supplies one PR URL and a valid GitHub token
- **THEN** the system fetches the PR metadata, file list, and diff, and reports the count of changed files and the resolved `head_sha` and merge-base SHA

#### Scenario: Multiple PRs ingested together
- **WHEN** the reviewer supplies three PR URLs
- **THEN** the system ingests all three and retains each artifact tagged with its originating PR id

#### Scenario: Invalid or inaccessible PR
- **WHEN** a supplied URL is malformed, or the token lacks access to the repository
- **THEN** the system reports that specific PR as failed with the reason, and continues ingesting the remaining PRs

### Requirement: Content-addressed ingestion cache
The system SHALL cache all fetched PR payloads keyed by `pr_id + head_sha` and serve subsequent reads from cache without network calls.

#### Scenario: Re-opening an unchanged PR
- **WHEN** the reviewer re-ingests a PR whose `head_sha` is unchanged since the last ingestion
- **THEN** the system serves the cached payload and issues no GitHub API calls beyond a single head-SHA check

#### Scenario: PR head has advanced
- **WHEN** the reviewer re-ingests a PR whose `head_sha` differs from the cached value
- **THEN** the system invalidates the cached entry for that PR and re-fetches all payloads

### Requirement: Repository checkout for analysis
The system SHALL obtain a local checkout of each PR's repository and create worktrees at the PR merge-base and at the PR head.

#### Scenario: First analysis of a repository
- **WHEN** a PR from a repository not yet cloned locally is ingested
- **THEN** the system clones the repository and creates worktrees at the merge-base and head commits

#### Scenario: Subsequent PR from the same repository
- **WHEN** a second PR from an already-cloned repository is ingested
- **THEN** the system fetches the required refs into the existing clone rather than re-cloning

#### Scenario: Checkout fails
- **WHEN** the clone or fetch fails
- **THEN** the system reports the failure and does not proceed to parsing or resolution for that PR

### Requirement: Build root detection
The system SHALL determine each analyzed project's build root from the nearest ancestor build file of the changed source files, SHALL report when the changed files span more than one build root, and SHALL treat a fast readiness signal combined with a high unresolved-reference count as a fatal misconfiguration.

#### Scenario: Project builds from a subdirectory
- **WHEN** a repository has no build file at its root and the changed sources live under a subdirectory containing one
- **THEN** the system uses that subdirectory as the build root

#### Scenario: Build file at the repository root
- **WHEN** the repository root contains a build file
- **THEN** the system uses the repository root as the build root

#### Scenario: Changed files span multiple build roots
- **WHEN** the changed sources belong to more than one build root
- **THEN** the system reports every build root involved and states which modules are not covered by the analysis

#### Scenario: Misconfiguration signature detected
- **WHEN** the language server reports readiness within seconds while a high proportion of references in changed files are unresolved
- **THEN** the system fails with a build-root misconfiguration error rather than reporting a degraded graph

### Requirement: Cross-PR overlap detection
When more than one PR is ingested, the system SHALL identify symbols changed by more than one PR and mark them as overlapping.

#### Scenario: Two PRs change the same method
- **WHEN** PR #101 and PR #102 both modify `BillingServiceImpl#process(String)`
- **THEN** the system marks the corresponding change unit as overlapping and records both PR ids against it

#### Scenario: No overlap
- **WHEN** the ingested PRs touch disjoint sets of symbols
- **THEN** the system reports zero overlapping symbols

### Requirement: Cache retention by artifact class
The system SHALL apply retention policy per artifact class: repository clones are retained until explicitly pruned; worktrees and language-server indexes expire on a configurable TTL and are additionally evicted least-recently-used under a size cap; GitHub API payloads expire on a shorter TTL; results keyed by a commit SHA are never expired by time; reviewer-authored drafts and reviewed state are never evicted.

#### Scenario: Index expires, clone is retained
- **WHEN** a language-server index exceeds its TTL
- **THEN** the index is removed and the repository clone is retained

#### Scenario: Size cap reached
- **WHEN** the combined size of worktrees and indexes exceeds the configured cap
- **THEN** the least recently used entries are evicted until the cache is under the cap, and clones are not evicted

#### Scenario: SHA-keyed results are not time-expired
- **WHEN** resolution results keyed by a commit SHA age beyond any TTL
- **THEN** they remain valid and are served from cache

#### Scenario: Reviewer data is protected
- **WHEN** any eviction runs
- **THEN** no draft comment and no reviewed state is removed

#### Scenario: Explicit prune
- **WHEN** the reviewer runs an explicit prune
- **THEN** the system reports what will be removed and the space reclaimed before removing it

### Requirement: Rate limit and quota handling
The system SHALL batch metadata requests, use conditional requests where supported, and surface the remaining GitHub API quota.

#### Scenario: Approaching rate limit
- **WHEN** the remaining GitHub API quota falls below a configured threshold during ingestion
- **THEN** the system warns the reviewer and reports the quota reset time

#### Scenario: Rate limit exceeded
- **WHEN** GitHub returns a rate-limit error
- **THEN** the system halts further requests, retains all already-ingested data, and reports which PRs were not ingested
