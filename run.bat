@echo off
rem Serves web/ and writes traded Pokémon into PK3/ at the project root.
rem Pass a port as the first argument to use something other than 8000.
setlocal
set "PY=python3"
where python3 >nul 2>nul || set "PY=python"
%PY% "%~dp0serve.py" %*
