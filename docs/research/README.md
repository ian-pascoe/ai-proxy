# Go behaviour research

Reference notes on the Go server written before and during the port. Go paths (`internal/...`, `sdk/...`) are relative
to the reference checkout `.repos/CLIProxyAPI` (upstream [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
cloned by `pnpm install`). Line numbers were taken at upstream commit `67465884` (the last upstream commit this repository
contained); on a newer checkout use `git -C .repos/CLIProxyAPI show 67465884:<path>` or search by symbol name.
