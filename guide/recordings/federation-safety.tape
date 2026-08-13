Output guide/videos/federation-safety.mp4

Require node
Require jq

Set Shell "zsh"
Set Theme "Catppuccin Mocha"
Set FontSize 22
Set Width 1280
Set Height 800
Set Padding 24
Set TypingSpeed 20ms
Set Framerate 30

Hide
Type "source guide/recordings/demo-env.sh" Enter
Show

Type "rooms setup | jq '{authorityId, networkListener}'" Enter
Sleep 3s
Type "rooms machine list --state-dir $ROOMS_STATE_DIR | jq '{machines: [.machines[] | {authorityId, locality}], count: (.machines | length)}'" Enter
Sleep 3s
Type "rooms federation peer list --state-dir $ROOMS_STATE_DIR | jq '{trustedPeers: length}'" Enter
Sleep 3s
Type "printf '\nEnrollment authenticates a machine; channel and runtime access need separate grants.\nEnroll only machines you control.\n'" Enter
Sleep 5s
Type "printf '\nRead SECURITY.md, then connect over SSH:\nrooms federation peer connect --transport ssh --ssh-host user@trusted-host\n'" Enter
Sleep 5s

Hide
Type "cleanup_rooms_demo" Enter
Show
