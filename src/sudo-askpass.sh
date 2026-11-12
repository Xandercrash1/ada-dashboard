#!/bin/sh
# Hands sudo the password typed into the dashboard console (see /api/terminal/exec). sudo runs this
# only because the console sets SUDO_ASKPASS and calls sudo with -A; the password lives in the
# environment of that one command and is never written to disk or logged.
printf '%s\n' "$ADA_SUDO_PW"
