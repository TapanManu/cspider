## ADDED Requirements

### Requirement: Drafting comments against a node
The system SHALL allow the reviewer to draft a comment from any node or call-site excerpt, and SHALL resolve the comment to a GitHub anchor consisting of file path, line or line range, diff side, and the `head_sha` commit id at draft time.

#### Scenario: Comment drafted on a changed method
- **WHEN** the reviewer drafts a comment on a MODIFIED method node
- **THEN** the draft is stored with an anchor of the head-side file path, the method's changed line range, and the current `head_sha`

#### Scenario: Comment drafted on a call site outside the diff
- **WHEN** the reviewer drafts a comment on a BROKEN call-site excerpt in a file not part of the PR diff
- **THEN** the system reports that the location is not commentable inline and offers to post it as a PR-level comment referencing that location

#### Scenario: Anchor cannot be resolved
- **WHEN** an anchor cannot be resolved to a valid position in the PR diff
- **THEN** the system rejects the draft at creation time with the reason, rather than deferring the failure to submission

### Requirement: Suggestion blocks
The system SHALL support drafting a comment containing a GitHub suggestion block so the author can apply the change directly.

#### Scenario: Suggestion drafted
- **WHEN** the reviewer enters replacement source for a specific line range
- **THEN** the draft body contains a correctly formed GitHub suggestion block covering exactly that range

#### Scenario: Suggestion spanning a multi-line range
- **WHEN** the reviewer selects a multi-line range for a suggestion
- **THEN** the anchor records both the start and end lines and the suggestion replaces the whole range

### Requirement: Local-first draft storage
All drafts SHALL be stored locally and SHALL NOT be transmitted to GitHub until an explicit submission is confirmed.

#### Scenario: Drafts survive restart
- **WHEN** the reviewer creates drafts, closes the tool, and reopens the same PR
- **THEN** all drafts are restored unsubmitted

#### Scenario: No premature writes
- **WHEN** the reviewer creates, edits, or deletes drafts
- **THEN** no write request is issued to the GitHub API

### Requirement: Batch review assembly
The system SHALL accumulate drafts across nodes and across PRs and assemble one review submission per PR with an event of COMMENT, APPROVE, or REQUEST_CHANGES.

#### Scenario: Multiple drafts on one PR
- **WHEN** the reviewer has six drafts on a single PR and chooses REQUEST_CHANGES
- **THEN** the system assembles one review containing all six inline comments with the REQUEST_CHANGES event

#### Scenario: Drafts across multiple PRs
- **WHEN** the reviewer has drafts on three PRs and submits
- **THEN** the system assembles and submits one review per PR, each containing only that PR's drafts

#### Scenario: Shared finding across PRs
- **WHEN** the reviewer applies one comment body to the same finding in three PRs
- **THEN** each PR receives its own comment with that body anchored to its own location

### Requirement: Explicit submission confirmation
Before any write to GitHub, the system SHALL display the exact payload to be sent — every comment body with its file, line, and side, plus the review event — and SHALL require explicit approval.

#### Scenario: Confirmation shown
- **WHEN** the reviewer initiates submission
- **THEN** the system displays every comment that will be posted with its resolved location and the review event, and waits for approval

#### Scenario: Submission cancelled
- **WHEN** the reviewer declines at the confirmation step
- **THEN** no request is sent and all drafts remain intact

### Requirement: Stale head protection
The system SHALL verify the PR head has not advanced since ingestion immediately before submission, and SHALL block submission if it has.

#### Scenario: Head advanced before submit
- **WHEN** the PR head SHA at submission time differs from the ingested `head_sha`
- **THEN** the system blocks submission, reports the SHA change, and prompts the reviewer to re-ingest and re-anchor the drafts

#### Scenario: Head unchanged
- **WHEN** the head SHA matches the ingested value
- **THEN** submission proceeds to the confirmation step

### Requirement: Submission outcome reporting
The system SHALL report the outcome of each submission and SHALL retain drafts that failed to post.

#### Scenario: Submission succeeds
- **WHEN** a review is accepted by GitHub
- **THEN** the system records the review id, marks those drafts as submitted, and links them to the posted comments

#### Scenario: Partial failure across PRs
- **WHEN** submission succeeds for one PR and fails for another
- **THEN** the system reports both outcomes, marks the successful drafts submitted, and retains the failed PR's drafts unsubmitted with the error

### Requirement: Existing thread interaction
The system SHALL display existing review threads on the nodes they anchor to, and SHALL allow replying to and resolving those threads.

#### Scenario: Existing thread shown on a node
- **WHEN** a node's source range overlaps an existing review comment's location
- **THEN** that thread is displayed within the node view with its full comment history

#### Scenario: Reply to a thread
- **WHEN** the reviewer replies to an existing thread
- **THEN** the reply is drafted locally and submitted through the same confirmation flow as new comments

#### Scenario: Resolve a thread
- **WHEN** the reviewer resolves an existing thread
- **THEN** the system marks it resolved on GitHub after confirmation and reflects the resolved state in the node view
