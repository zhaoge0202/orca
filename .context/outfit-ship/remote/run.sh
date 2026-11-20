#!/usr/bin/env bash
# Runs on Omarchy from the repo root: outfit fixture shots at 1x and 2x.
set -u
OUT=/tmp/avatar-outfits-qa
rm -rf "$OUT"; mkdir -p "$OUT/shots1" "$OUT/shots2"
pnpm fixtures:shot 'bots/BotAvatarOutfits' --scale 1 --out "$OUT/shots1" 2>&1 | tail -3
pnpm fixtures:shot 'bots/BotAvatarOutfits' --scale 2 --out "$OUT/shots2" 2>&1 | tail -3
pnpm fixtures:shot 'bots/BotPicturePicker:newOutfit' --scale 2 --out "$OUT/shots2" 2>&1 | tail -3
pnpm fixtures:shot --stop >/dev/null 2>&1
tar -C "$OUT" -czf /tmp/avatar-outfits-qa.tgz . && sha256sum /tmp/avatar-outfits-qa.tgz
