#!/bin/zsh

set -euo pipefail

clear
print -P '%F{cyan}%BROOMS ARCHITECTURE%b%f'
print
sleep 1
print '  rooms CLI'
print '      |  authenticated local request'
print '      v'
print -P '  %F{green}roomsd daemon%f  ----->  SQLite state + event journal'
sleep 2
print '      |'
print '      |  runtime binding + delivery frame'
print '      v'
print -P '  %F{yellow}Go runtime host%f  ----->  provider PTY  ----->  agent'
sleep 3
print
print -P '%F{cyan}%BOWNERSHIP%b%f'
print '  daemon: channels, sessions, messages, cursors, authority'
print '  Go host: one PTY generation, bounded replay, process lifecycle'
print '  terminal: observer or leased controller; never canonical truth'
sleep 4
print
print -P '%F{magenta}%BFEDERATION%b%f'
print '  trusted roomsd  <---- mutual enrollment + SSH relay ---->  roomsd'
print '  channel access: owner-granted admission per peer and channel'
print '  runtime access: signed, one-use capability scoped to one generation'
sleep 5
