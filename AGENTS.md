<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Persistent GitHub development workflow

- Work only on an approved development branch. Never modify, merge into, or
  push directly to `main` without explicit user confirmation.
- At the end of each independent development task, run the applicable checks,
  tests, and production build before claiming completion.
- When those checks pass, create a focused commit with a clear, human-readable
  message and run `git push` to that branch's configured remote.
- Never use `git push --force`, `git reset --hard`, or destructive cleanup to
  discard work. If local and remote history diverge or conflict, stop and
  report it rather than overwriting either side.
- Do not commit `.env` files, API keys, tokens, private reading progress,
  imported book content, or other personal/sensitive data. Inspect untracked
  files before staging.
- A failing test or build means the task is not complete: keep fixing it or
  report the blocker clearly. If a push fails, report that it was not synced.
- End every task report with the change summary, test results, commit SHA,
  branch name, and GitHub sync result.
