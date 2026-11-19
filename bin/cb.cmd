@setlocal
@rem Node's compile cache: converting cb's TypeScript was ~190 ms of every call (bin/cb says more)
@if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%TEMP%\cb-node-cache"
@node "%~dp0..\cli\cb.ts" %*
