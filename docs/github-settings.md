# GitHub repository settings

These are the settings that live on GitHub rather than in the repository, so they
cannot be applied by a commit. Everything below was verified against the repo on
16 Nov 2026; the two API calls that would automate it returned
`403 Resource not accessible by personal access token`, because the stored token
is a fine-grained one without **Administration: write**.

## Require CI before merging to `main`

**Settings → Branches → Add branch protection rule** (or **Rules → New ruleset**):

- Branch name pattern: `main`
- ☑ Require status checks to pass before merging
- Add status check: **`test`** — this is the job name in `.github/workflows/ci.yml`
- Leave "Require branches to be up to date" off unless you want rebases enforced
- Save

Equivalently, with a token that has admin rights:

```sh
gh api -X PUT repos/tcz009/network-advisor/branches/main/protection \
  -f 'required_status_checks[strict]=false' \
  -f 'required_status_checks[contexts][]=test' \
  -F 'enforce_admins=false' \
  -F 'required_pull_request_reviews=null' \
  -F 'restrictions=null' \
  -F 'allow_force_pushes=false' \
  -F 'allow_deletions=false'
```

Or as a ruleset (the modern form):

```json
{
  "name": "protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [{
    "type": "required_status_checks",
    "parameters": {
      "required_status_checks": [{ "context": "test" }],
      "strict_required_status_checks_policy": false
    }
  }]
}
```

## What this does and does not prevent

- It blocks **merging a pull request** whose CI is red, failed, or missing.
- It does **not** block a direct `git push` to `main`. If that matters, add a
  ruleset that restricts pushes to `main`, and work through pull requests.

## CI expectations

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, and:

1. syntax-checks `server.js`, `oui.js`, `public/app.js` and `deploy/redeploy.sh`;
2. runs the full `node --test` suite;
3. builds the image and **runs it**, curling `/api/pulse` and `/api/state`;
4. asserts `ROLE=agent` refuses to start without `ADVISOR_HUB`.
