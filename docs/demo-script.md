# 60-second demo recording

Everything on screen is invented: a bike shop called Fernhollow Cycle Works and its customers. The demo needs no keys and sends nothing anywhere.

## Before you record

1. Clone the repo into a neutral folder, such as `~/demo/agent-ops-demo`.
2. Set a plain prompt so the recording shows no username, machine name or folder path:

   ```bash
   PS1='$ '
   ```

3. Run `npm ci`, then `clear`.
4. Use a large terminal font and close anything else on screen, including notifications.

## Recording

Start recording, then run:

```bash
npm run demo -- --slow
```

The `--slow` flag pauses 8 seconds after each of the 7 sections, which comes to about 56 seconds.

| Time | On screen                                          | Say                                                                                                                                                                                                           |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Command typed, seed line                           | "This is an agent for a made-up bike shop. It can update the shop's customer records, and the rule is that it can't contact anyone on its own."                                                               |
| 0:08 | Draft appears, outbox 0                            | "Staff ask for an email. The agent looks up the customer and writes a draft. The outbox is still empty, because the agent has no tool that sends."                                                            |
| 0:16 | `yes, send it`, then `APPROVE d_1` twice           | "A casual yes does nothing. Only APPROVE with the draft's id sends, and plain code handles it before the model sees it. Approving again doesn't send twice."                                                  |
| 0:24 | Rejected `update_customer`, then the change record | "Someone else edited this customer first, so the stale update is rejected. The agent reads them again and retries. The update names only the field it changes, and success is only reported after a re-read." |
| 0:32 | Weekly summary job                                 | "Long work goes to a durable queue. Here's a real PDF, and asking twice wouldn't start a second job."                                                                                                         |
| 0:40 | Two failed attempts, `degraded`                    | "This job keeps failing. It retries with backoff, then stops, and the health check says so."                                                                                                                  |
| 0:48 | `--all` refused, exact id requeued, `ok`           | "Recovery is deliberately narrow. A blanket replay is refused, you name the exact job, and health goes back to OK."                                                                                           |
| 0:56 | `Demo finished`                                    | "Everything you saw also runs as an automated evaluation suite."                                                                                                                                              |

## Optional closing shot

If you have a few seconds spare, run `npm run eval` to show the pass/fail table.

## Telegram version

For a recording in Telegram with the live agent, including voice notes, see [demo-telegram.md](demo-telegram.md).
