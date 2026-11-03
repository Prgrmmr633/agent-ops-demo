# Progress log

## Choices made where the spec left room

- Node 26 with the built-in `node:sqlite` driver and native TypeScript execution, so there is no native compile and no build step.
- The fake business is a bike repair shop, chosen to stay far from any real workflow. Each fake customer carries their own bike and repair status, so the four customer tools reach all of the data.
- Tests and tooling are only claimed for the environment they actually ran in: Node 26 on macOS.

## Step 0: scaffold

- Done: local git repo, strict TypeScript, Biome, Vitest, CI workflow file (not enabled, nothing pushed), SQLite helper.

## Step 1: data service

- Done: `CustomerStore` with revisioned customers, a fixed set of named fields, field-level patches, a change log, and verification by re-reading after the commit.
- Tested: stale revisions, a two-connection race, rollback when the change log cannot be written, unknown and invalid fields, and silent data loss injected with SQLite triggers.
- Choice: a patch value replaces the field and `null` clears it. A customer's name can change but never be cleared. Lists such as notes are replaced whole.

## Step 2: MCP server

- Done: `find_customers`, `get_customer`, `update_customer` and `list_changes` on the official MCP SDK, served statelessly over Streamable HTTP with a bearer token.
- Tested: a real HTTP round trip, wrong and missing tokens, schema rejection of generic path operations and unknown fields, and proof that the audit actor comes from the server.
- Choice: HTTP only, no stdio. The agent and worker run as separate services and share one transport.

## Step 3: drafts and approval gate

- Done: draft store, strict command parser, `ApprovalGate`, `OutboundAdapter` interface and a local outbox stub.
- Commands: `APPROVE <draft-id>` sends and `REJECT <draft-id>` drops. A bare `APPROVE` or `REJECT` lists the waiting drafts and sends nothing.
- Tested: simultaneous approvals, unknown ids, drafts private to their chat, rejected drafts never sent, near-miss commands, and no retry after a failed send.

## Step 4: agent and Telegram

- Done: hand-written tool loop, Anthropic client, scripted model, `StaffRouter`, grammY layer.
- Tested: approvals bypassing the model, no send tool offered, and the SDK request shape checked through a stubbed `fetch`.
- Choice: a hand-written loop instead of the SDK's beta tool runner, because evals need to swap the model and capture every tool call.
- Real model: steps 15 to 17 cover live runs. Real Telegram: see step 15.

## Step 5: job runner

- Done: durable SQLite queue with exponential backoff, idempotency keys, worker leases with heartbeats, exact-id requeue, recovery command, health endpoint, a real weekly summary PDF job and a clearly labelled simulated transcode.
- Tested: crash recovery, a stale worker unable to overwrite a newer attempt, all-or-nothing requeue, and blanket selectors refused.
- Choice: the agent's job tool derives the idempotency key in code, so a repeated model call cannot create a second job.
- Choice: a job that has used up its attempts only leaves `failed` through an exact-id requeue. Nothing retries it automatically.

## Step 6: evaluation harness

- Done: 17 JSON scenarios, a harness that runs the real store, MCP, router and gate, a scorer, a table and JSON report, and scripted and live modes.
- Fixed during review: the first version only checked final state, so a wrong send at turn 2 could look fine by turn 4. Turns can now assert their own reply. Unused script steps now fail a scenario too.
- Proof the scorer can fail: tests feed it tampered traces and rogue models and require a failing score.
- Limit: scripted mode tests the system around the model, not the model's judgement. Live mode exists for that.
- Live mode: step 15 covers it. Without a key it exits non-zero and writes nothing.

## Step 7: voice adapter

- Done: `VoiceAdapter` interface, ElevenLabs implementation behind `VOICE_ENABLED`, staff voice notes transcribed into the normal flow, and approved voice drafts rendered to audio.
- Tested: request shapes checked against the provider's public API docs through a stubbed `fetch`, with tests using a fake adapter.
- Choice: a transcript is tagged `voice` and can never approve a send, even if it reads exactly like the command.
- Live check: step 14 covers it.

## Step 8: seed, demo and Docker Compose

- Done: seed script, end-to-end demo on fake data, Dockerfile, Compose file with `telegram` and `tools` profiles, `.env.example`.
- Docker: not run at this step, because the daemon was not running. Step 13 covers it.

## Step 9: documentation

- Done: README, MIT license, `docs/demo-script.md`.
- Choice: the case studies use only the three short descriptions supplied, and name no chat product, to follow the no-vendor rule.
- Case studies: rewritten in step 18.

## Step 10: first full verification

- Mutation check: 28 deliberate breaks of safety rules. The first run caught 27. The survivor showed that the toolbox allowlist was untested, so a test was added and all 28 were caught. Step 12 repeats this against the current design.
- Leak scan of tracked files and full history: no secrets, no machine paths, only reserved example addresses and fiction-range phone numbers, one author identity and no trailers.

## Step 11: naming and update shape

- Changed: the MCP tools became `find_customers`, `get_customer`, `update_customer` and `list_changes`. `update_customer` takes a revision number and a patch of named fields, and still verifies by re-reading after the commit.
- Changed: approvals became `APPROVE <draft-id>` and `REJECT <draft-id>`, so a command can only ever mean one draft.
- Updated to match: tests, eval scenarios, demo, README, `docs/demo-script.md` and this log.

## Step 12: mutation check on the current design

- Ran: 33 deliberate breaks in a fresh clone. These were the 28 from step 10, updated for the customer tools and the new commands, plus 5 new ones: re-read skipping the field comparison, unknown fields silently dropped, a clearable name, null stored instead of clearing, and a bare `APPROVE` guessing the draft. The tests caught all 33.
- Found: one break was caught only by a check on the tool's published schema, not by its behaviour. If the store's schema were loosened, a patch mixing a valid field with an unknown one would drop the unknown field and still report success. Two behaviour tests now cover this, at the store and at the MCP tool. Both fail against that break.
- Passed after the change: lint, typecheck, 289 tests, and 17 of 17 eval scenarios.

## Step 13: Docker Compose

- Ran: built the image from a fresh clone of the committed code and started the stack under its own project name, following the README (`cp .env.example .env`, then `docker compose up`). Environment: Docker 29 on macOS, with Linux arm64 containers.
- Passed: the data service healthcheck and the seed service. From inside the worker container over the Compose network, all four tools were listed, a field patch was verified, a stale revision was rejected, and an unknown field was rejected. Jobs ran, including a real PDF written to the shared volume. Health showed degraded and then ok. In the container, `requeue --all` was refused and an exact-id requeue worked. The data service is not published to the host. Containers run as the non-root `node` user. Both services exited with code 0 on stop, and data survived a stop and start. The `telegram` profile's agent refuses to start without its settings.
- Cleaned up: all containers, the volume, the network and the images from the check were removed.
- Not run: the Telegram agent service against real Telegram.

## Step 14: live ElevenLabs check

- Key: created for this project, limited to the Text to Speech and Speech to Text endpoints, with a 2000-credit cap. It is stored only in the git-ignored `.env` and was never printed.
- Passed: the project's own `ElevenLabsVoice` adapter turned a sentence into a 128 kbps MP3, and speech to text returned the same 9 words. A call needing another permission (`voices_read`) was refused, which confirms the key's limits.

## Step 15: live evaluation

- Ran: all scenarios against Claude Sonnet 5.5 through the real store, MCP server, router and approval gate, using a key in the git-ignored `.env`. It took 101 seconds.
- Passed: 14 of 14 live scenarios and 130 of 130 checks. The 3 scenarios that need a deliberately misbehaving scripted model were skipped by design. The report is `docs/eval-report.live.json`.
- Limit found at this step: live checks mostly covered actions and state, not wording, and the report did not keep the replies. Step 16 fixed both.
- Telegram: a bot was created and its token checked against the bot's ID, but Telegram's cloud Bot API returned 502 or timed out for it. This matches a Telegram-side outage affecting specific bot IDs on 2026-11-03, so the chat front end has not been tested end to end.

## Step 16: reply checks

- Added: every report now keeps each scenario's conversation. Seven scenarios check the model's own final words, case-insensitively: one phrase from each listed group must appear, and no excluded phrase may. Text added by code, such as draft previews and approval replies, is never counted as the model's words.
- Tested: a scripted model that claims success after a failed save now fails its scenario, and new scorer tests cover each part of the check.
- Passed: 295 tests, 17 of 17 scripted scenarios (189 checks), and 14 of 14 live scenarios on Sonnet 5.5 (158 checks).
- Found by reading the live transcripts, not by the checks: (1) when staff typed `approve d_1` in lowercase, the model suggested the approval step might be failing on the system side, instead of saying the command must be typed exactly in capitals; (2) replies use Markdown, which the Telegram bot shows as literal asterisks; (3) the model guessed pronouns for customers from their names. Step 17 fixes all three.

## Step 17: prompt fixes from reading live transcripts

- Fixed in the system prompt: replies must be plain text; customers are referred to by name or as "they", never by guessed pronouns; an approval only counts as the whole message in capitals, and anything else gets a plain explanation and the exact command instead of a hint that the system is broken; after `verification_failed` the model must not retry the write.
- Checks added so these stay fixed: a plain-text check on every model reply in every scenario, a wording check on near-miss approvals, and pronoun checks on the eight scenarios that talk about customers. Before trusting them, they were run against the earlier live replies and flagged every problem found by reading and nothing that was correct. Two matching bugs came up and are covered by tests: a pronoun followed by punctuation was missed, and a phrase could match across two sentences.
- Iteration: the first re-run fixed near-miss approvals and Markdown, but still used pronouns in two scenarios, and in one scenario the model retried a failed save, writing to the record twice. Neither the earlier prompt nor the earlier run had shown the retry, which shows that a model's behaviour can vary between runs. Both rules were tightened.
- Passed: 305 tests, 17 of 17 scripted scenarios (273 checks), and 14 of 14 live scenarios on Sonnet 5.5 (239 checks). Every transcript was read, and no model reply in any scenario uses a gendered pronoun.
- Limit: one clean live run is evidence, not a guarantee.

## Step 18: case studies

- Rewritten after the owner described their role in each project and the claims were checked against the records available (project history, release notes, activity records and chat history), read-only and without copying anything into this repo.
- Kept only what the owner stated or the records supported. Outcomes that the records did not show were removed, and one claim of sole authorship was changed to a contribution.
- No client, employer, product, vendor or host is named, and there are no numbers.

## Step 19: default model

- Changed: the default model in `.env.example` is now Claude Sonnet 5.5, the model that passed the live evaluation. Other models have not been run live.

## Step 20: publishing

- The working history was condensed into a short series of commits, each adding one working part of the current design and each passing lint, typecheck and its tests. The full working history is kept privately. Commits link to the owner's GitHub account through its no-reply address.
- Pushed `main` to a private GitHub repository for review, then made it public on 2026-11-03 after the owner's review. Verified on GitHub: only `main` is present, its latest commit matches the local one, the same files are tracked, and no private file such as `.env` was uploaded.
- Passed: the GitHub Actions workflow on GitHub's hosted Linux runner (install, lint, typecheck, tests and the scripted evaluation). Before pushing, the same steps also passed in a Node 26 Linux container.

## Next

- Try the agent in Telegram once the Bot API answers for the bot: a draft, a casual "yes", `APPROVE`, `REJECT` and a voice note, then check the outbox.
- Run the live evaluation a few more times to see how consistent the model is.
- Owner task: record the demo and link it from the README.
