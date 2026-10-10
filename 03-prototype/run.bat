@echo off
REM Drop & Done prototype launcher (Windows). Needs only a JDK 8+.
REM Optional: set ANTHROPIC_API_KEY before running to enable live Claude extraction.
REM Optional: set PORT to use a port other than 8787.
setlocal
set "HERE=%~dp0"

REM Find javac on PATH; fall back to JAVA_HOME. java is taken from the same JDK folder,
REM so a newer javac on PATH is never paired with an older java (class version mismatch).
set "JDK="
for %%I in (javac.exe) do if not "%%~$PATH:I"=="" set "JDK=%%~dp$PATH:I"
if not defined JDK if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" set "JDK=%JAVA_HOME%\bin\"
if not defined JDK (
  echo Could not find javac. Install a JDK 8 or newer and put its bin folder on PATH, or set JAVA_HOME.
  exit /b 1
)

if not exist "%HERE%server\out" mkdir "%HERE%server\out"
"%JDK%javac.exe" -encoding UTF-8 -d "%HERE%server\out" "%HERE%server\DropDoneServer.java" || exit /b 1

REM Windows-ROOT trust store + system proxy so corporate TLS inspection / proxies work.
"%JDK%java.exe" -Djavax.net.ssl.trustStoreType=Windows-ROOT -Djava.net.useSystemProxies=true ^
  -cp "%HERE%server\out" DropDoneServer "%HERE%.."
