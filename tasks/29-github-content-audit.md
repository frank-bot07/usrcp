# GitHub adapter content-filter audit

Date: 2026-05-18
Branch: `feat/github-content-audit`

## Why

The GitHub adapter wave (#57 → #58 → #59 → #60) shipped four PRs in ~12 hours and culminated in `pr_reviewed` events that capture activity on **someone else's** PRs. Chad flagged the pattern in his PR #62 pre-review:

> Are third-party PR bodies, review comments, and issue bodies getting stored unredacted into your local ledger? That's exactly the kind of thing that becomes a "we shipped a data-leak" headline six months later.

Per the saved [[feedback_fast_waves_need_content_audits]] memory: pause-and-sweep after rapid waves on user-data surfaces, classify every stored field, confirm category-3 is intentional or redact it. This is that sweep.

## Method

Walk every `captureXxx` function in `packages/usrcp-github/src/capture.ts`. For each `detail` field stored on the ledger, classify:

- **Category 1**: the user's own content
- **Category 2**: third-party content with consent (user actively opted in, e.g. by reviewing someone's PR)
- **Category 3**: third-party content as collateral (mentioned in someone else's content; the user didn't explicitly opt in to STORING it, even if they saw it in the act of doing their own action)

Plus: verify size caps. The ledger rejects `detail` >64KB; the adapter must not produce events past that ceiling.

## Findings per event type

### `pr_opened` - PR YOU authored

| Field | Category | Notes |
|---|---|---|
| node_id, number, created_at, updated_at, state, merged | 1 | Metadata about your action |
| title, body | 1 | You wrote them |
| owner, repo, url | 2 | Repo identifier; consented via the org allowlist |
| author_login | 1 | That's you (search query filters to `author:X`) |

### `pr_merged` / `pr_closed` - terminal state events on YOUR PRs

Same shape as `pr_opened`, without `body`. All fields category 1 or 2.

### `issue_opened` - issue YOU authored

Same shape as `pr_opened`. All fields category 1 or 2.

### `issue_commented` - comment YOU wrote on any issue/PR

| Field | Category | Notes |
|---|---|---|
| comment_id, node_id, created_at, updated_at | 1 | Metadata about your comment |
| body | 1 | You wrote the comment |
| owner, repo, url, issue_url, issue_number | 2 | Parent identifier; consented via allowlist + by you commenting there |
| is_pr_parent | 1 | Derived classification |
| author_login | 1 | That's you (filtered in pollIssueComments) |
| **issue_title** | **3** | Parent issue/PR title - written by SOMEONE ELSE when you comment on their issue/PR |

### `pr_reviewed` - review YOU submitted on someone else's PR

| Field | Category | Notes |
|---|---|---|
| review_id, node_id, submitted_at, state, body | 1 | Your review action and your review body |
| owner, repo, url, pr_url, pr_number | 2 | Repo + PR identifier; consented |
| reviewer_login | 1 | That's you |
| **pr_title** | **3** | Title of the PR you reviewed - written by the PR author |
| **pr_author_login** | **3** | The colleague whose PR you reviewed |
| **external_user_id (= pr_author_login)** | **3** | **Intentional**: the agent-grep affordance "PRs I reviewed for Alice" |

## Verdict on the four category-3 fields

| Field | Decision | Rationale |
|---|---|---|
| `issue_commented.issue_title` | **Keep** | Necessary for timeline scannability (`anthropics/usrcp#42 comment: lgtm`) - without the title, the timeline becomes opaque numeric refs. The title is metadata, not body content. |
| `pr_reviewed.pr_title` | **Keep** | Same as above. The summary is `<repo>#<N> approved: <title>`; the title is the only humanizing context. |
| `pr_reviewed.pr_author_login` | **Keep - intentional** | This is the agent-grep affordance Chad explicitly designed for ("PRs I reviewed for Alice"). It's category 3 in a strict classification but it's also the entire point of the field. Documented in `pr_reviewed` design doc. |
| `pr_reviewed.external_user_id` (= pr_author_login) | **Keep - intentional** | Same as above. |

**What we do NOT store** (good news):

- No third-party comment bodies (only your own comments).
- No third-party review bodies (only your own reviews).
- No reviewer logins on PRs you authored (only your PR author info).
- No inline review comments (deferred to v1.4; the top-level review object is captured).
- No discussion content (out of scope entirely).
- No commit metadata (separate REST endpoint, out of scope).

## Real bug surfaced: 64KB detail cap could infinite-loop the poller

The ledger's `appendEvent` validates `JSON.stringify(detail).length <= 65_536`. Pre-this-PR, the GitHub adapter stored full body fields with no cap. A pathological event - dependency-update PR with a 100KB auto-generated description, a manifest paste in a comment, etc. - would:

1. Cause `appendEvent` to throw "detail exceeds 64KB".
2. Abort `captureGitHubActivity` mid-call.
3. Abort the `pollOnce` loop's `for...of` iteration.
4. NOT advance the cursor (the bad event's `created_at` was never reached).
5. Next tick: re-fetch the same window, hit the same bad event, throw again.
6. Loop forever until the operator manually intervened.

**Fix**: cap bodies at 16KB in `truncateBody()` before storing. Marker `[...usrcp: body truncated, original was N chars]` appended so the truncation is self-describing.

16KB rationale:
- 95th percentile of real PR/issue/comment bodies fits well under.
- Leaves 48KB of headroom for the rest of the detail fields + JSON encoding overhead.
- The hard ceiling (64KB) is 4x the cap, so even pathological non-body fields can't push the serialized detail past the ledger ceiling.

## Surface area of fixes shipped in this PR

**Modified:** `packages/usrcp-github/src/capture.ts`
- New `BODY_MAX_CHARS = 16384` constant.
- New `truncateBody(text)` helper. Returns the input unchanged when under cap, returns `<truncated>[...usrcp: body truncated, original was N chars]` when over.
- All four body-storing call sites (`captureOpened`, `captureIssueOpened`, `captureComment`, `captureReview`) pipe `activity.body` through `truncateBody()`.

**Tests:** `packages/usrcp-github/src/__tests__/capture.test.ts`
- New `describe("body truncation")` block, 7 tests:
  - pr_opened body truncated when >16KB
  - pr_opened body passes through unchanged when <16KB
  - pr_opened body=null preserved (PR with no description)
  - issue_opened body truncated
  - issue_commented body truncated
  - pr_reviewed body truncated
  - Serialized detail stays under 64KB ledger cap when body is 70KB

## Verification

- `(cd packages/usrcp-github && npm test)` → 90/90 pass (was 83 pre-fix; +7 truncation tests)
- No usrcp-local changes; nothing else affected

## What this PR is NOT doing (deferred / out of scope)

- **Retroactive scrubbing**: existing events with bodies in the ledger from pre-fix days are unchanged. A future PR could ship a one-time migration that re-truncates them, but the more common shape will just be "wait for old events to age out / get deleted." Not blocking.
- **Per-field size caps for non-body fields**: nothing else is realistic at multi-KB scale.
- **Redaction of `pr_author_login` / `issue_title`**: kept by design (see verdict table). If a user wants to redact a specific stored event, the ledger has `delete_event` / similar tools.
- **Inline review comments**: the body of inline review comments would also be category 3 if we ever capture them. Make sure to redo this audit when v1.4 ships.

## Process note

[[feedback_fast_waves_need_content_audits]] worked: by classifying every field explicitly, I caught a real infinite-loop bug (the 64KB ledger cap interaction) that no single PR review on #57-#60 had surfaced. The bug wasn't introduced by any specific PR in the wave - it was always there - but the body-storing surface grew with every wave PR, so by v1.3 we had four endpoints that could trip it. The audit is the right moment to find class-of-bug issues that individual PRs miss.
