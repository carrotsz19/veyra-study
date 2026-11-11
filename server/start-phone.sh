#!/data/data/com.termux/files/usr/bin/sh
# Starts the Veyra group server on the phone and keeps it running.
# Termux:Boot runs this at power-on once it's copied to ~/.termux/boot/
termux-wake-lock
cd "$HOME/veyra-group" || exit 1
while true; do
  node group-server.mjs >> server.log 2>&1
  echo "$(date) server stopped, restarting in 5 s" >> server.log
  sleep 5
done
