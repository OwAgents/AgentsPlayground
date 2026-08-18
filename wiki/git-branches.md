## Git workflow

 ### Rebrand branches — never track agent-console
 
Branches like `rebrand/hermes3` are **rebrand branches** — they fork the app under a different name and identity. They must **never** be merged to `agent-console`.
 
 **Tracking rule**: always set upstream to the matching remote branch, never `origin/agent-console`:
 
 ```sh
 # CORRECT — tracks origin/rebrand/hermes3
 git push -u origin rebrand/hermes3
 
 # WRONG — would point release pushes at the base agent-console branch
 git branch -u origin/agent-console rebrand/hermes3
 ```
 
 If a rebrand branch tracks `origin/agent-console`:
- `git push` pushes directly to the base agent-console branch (one typo away from disaster)
 - `git status` says `ahead N, behind M` which implies these branches should converge — but they must not
 
 Check tracking at any time:
 ```sh
 git branch -vv | grep -E "^\*|^  "
 ```
 Each rebrand branch should show its own remote counterpart (e.g. `[origin/rebrand/hermes3: ahead N]`), never `[origin/agent-console: ...]`.
 
 To fix a branch that is incorrectly tracking `origin/agent-console`:
 ```sh
 git branch -u origin/rebrand/hermes3 rebrand/hermes3
 ```
