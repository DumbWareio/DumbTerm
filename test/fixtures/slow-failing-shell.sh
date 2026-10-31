#!/bin/sh
# Test fixture, run as SHELL: a shell that fails a little after it starts, still within the server's 1 s window
sleep 0.6
exit 2
