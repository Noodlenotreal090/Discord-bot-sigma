# Destinyy Auto Role Bot

Automatically gives role `1455150955585867796` when a member either:
- has `/destinyy` in their Discord custom status, or
- has this server set as their displayed primary server tag.

The bot only removes the role when it previously added it and recorded ownership in `ownership.json`.

## Setup

1. Install Node.js 20 or newer.
2. Create a Discord application and add a bot.
3. In Developer Portal > Bot, enable **Server Members Intent**, **Presence Intent**, and **Message Content Intent**.
4. Invite the bot with **Manage Roles** permission. Place its highest role above role `1455150955585867796`.
5. Copy `.env.example` to `.env` and fill in the bot token and server ID. Keep the token private.
6. Run:

   ```bash
   npm install
   npm start
   ```

## Commands

- `?sync` — syncs cached/fetched members; requires Manage Server permission.
- `?protect @member` — permanently protects a member from automatic role changes.
- `?unprotect @member` — removes that protection and checks eligibility again.

## Manual-role protection

If a member already has the target role before the bot adds it, the bot treats it as manually assigned and will not remove it. The bot records only roles it successfully adds itself in `ownership.json`. Use `?protect @member` if you want to explicitly protect someone who already received the role from the bot; the protected list is saved in `protected.json`.

Discord does not provide a reliable way to tell that an administrator intended to manually assign the same role to a member who already has it from the bot. Use `?protect @member` in that case. Back up `ownership.json` and `protected.json`; do not edit them while the bot is running.

## Notes

- Custom status visibility depends on Discord's presence privacy settings. Discord may omit custom statuses from bot presence events for some members.
- Server-tag matching checks `primaryGuild.identityGuildId` against the configured server ID and requires `identityEnabled === true`.
- If Discord omits either signal from an event, the bot avoids removing a role based on incomplete information.
