Output guide/videos/local-quickstart.mp4

Require node
Require jq

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 24
Set Width 1200
Set Height 800
Set Padding 24
Set TypingSpeed 22ms
Set Framerate 30

Hide
Type "source guide/recordings/demo-env.sh" Enter
Show

Type "rooms setup | jq '{operatorSessionId, stateMode, credentialMode}'" Enter
Sleep 2s

Hide
Type "start_rooms_demo_daemon" Enter
Show

Type "rooms channel create release-room --goal 'Verify the release' | jq '{channel: .channel.id, owner: .channel.ownerOperatorSessionId}'" Enter
Sleep 2s
Type "rooms session register --channel release-room --name alice --role worker | jq '{session: .session.id, role: .session.role}'" Enter
Sleep 1s
Type "rooms session register --channel release-room --name bob --role worker | jq '{session: .session.id, role: .session.role}'" Enter
Sleep 2s

Type "rooms runtime create --credential operator --session bob --runtime-id bob-runtime --channel release-room --command-json $ROOMS_DEMO_COMMAND_JSON | jq '{runtime: .runtime.runtimeId, state: .runtime.state}'" Enter
Sleep 2s
Type "ROOMS_SESSION_ID=alice ROOMS_CHANNEL_ID=release-room rooms session send bob --body 'Please verify the release' | jq '{delivered: .event.deliveredRecipientSessionIds, cursor}'" Enter
Sleep 3s
Type "ROOMS_SESSION_ID=bob ROOMS_CHANNEL_ID=release-room rooms message list --session bob --channel release-room --json | jq 'map({from: .senderSessionId, body})'" Enter
Sleep 4s

Hide
Type "rooms runtime terminate bob-runtime --credential operator --generation 1 >/dev/null" Enter
Type "cleanup_rooms_demo" Enter
Show
