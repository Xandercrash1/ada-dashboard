# Rule: Mandatory UI & API Verification
Always manually verify your changes before declaring them "complete" or telling the user they work.
If you deploy a new API endpoint, write a script (e.g. using `curl` or `fetch`) to actually hit that endpoint and verify it doesn't return a 404 or a 500 error.
If you deploy UI changes, confirm they don't break existing navigation or throw JavaScript errors by either viewing the console output locally or manually simulating interactions if possible. Never assume a deployment was successful simply because the `promote.sh` script completed.
