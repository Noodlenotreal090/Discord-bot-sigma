require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  PermissionsBitField,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID = process.env.ROLE_ID || '1455150955585867796';
const PREFIX = process.env.PREFIX || '?';

if (!TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in your .env file.');
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, 'ownership.json');
const TEMP_FILE = `${DATA_FILE}.tmp`;
const PROTECTED_FILE = path.join(__dirname, 'protected.json');
let protectedMembers = {};
try {
  if (fs.existsSync(PROTECTED_FILE)) {
    protectedMembers = JSON.parse(fs.readFileSync(PROTECTED_FILE, 'utf8'));
  }
} catch (error) {
  console.error('Could not read protected.json. Refusing to overwrite it:', error);
  process.exit(1);
}

function saveProtected() {
  const temp = `${PROTECTED_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(protectedMembers, null, 2));
  fs.renameSync(temp, PROTECTED_FILE);
}

function isProtected(guildId, userId) {
  return protectedMembers[guildId]?.includes(userId) ?? false;
}

function setProtected(guildId, userId, protect) {
  const ids = new Set(protectedMembers[guildId] || []);
  if (protect) ids.add(userId);
  else ids.delete(userId);
  protectedMembers[guildId] = [...ids];
  saveProtected();
}

// Only IDs in this file are roles this bot itself successfully added.
// Existing/manual roles are never added to this ownership list.
let ownership = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    ownership = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (error) {
  console.error('Could not read ownership.json. Refusing to overwrite it:', error);
  process.exit(1);
}

function saveOwnership() {
  fs.writeFileSync(TEMP_FILE, JSON.stringify(ownership, null, 2));
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

function ownsRole(guildId, userId) {
  return ownership[guildId]?.includes(userId) ?? false;
}

function setOwnsRole(guildId, userId, owned) {
  const ids = new Set(ownership[guildId] || []);
  if (owned) ids.add(userId);
  else ids.delete(userId);
  ownership[guildId] = [...ids];
  saveOwnership();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Serialize updates per member so simultaneous status/tag events cannot race.
const memberQueues = new Map();
function queueMember(member, work) {
  const key = `${member.guild.id}:${member.id}`;
  const previous = memberQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(work)
    .catch((error) => console.error(`Role sync failed for ${key}:`, error))
    .finally(() => {
      if (memberQueues.get(key) === next) memberQueues.delete(key);
    });
  memberQueues.set(key, next);
  return next;
}

function hasDestinyyStatus(presence) {
  return Boolean(
    presence?.activities?.some((activity) =>
      activity.type === ActivityType.Custom &&
      typeof activity.state === 'string' &&
      activity.state.toLowerCase().includes('/destinyy')
    )
  );
}

function getTagState(user, guildId) {
  const primaryGuild = user?.primaryGuild;
  // undefined means Discord did not include this field in this payload;
  // null means the user has no primary guild, so that is known to be false.
  const known = primaryGuild !== undefined;
  const usingThisServerTag = Boolean(
    primaryGuild?.identityGuildId === guildId &&
    primaryGuild?.identityEnabled === true
  );
  return { known, usingThisServerTag };
}

async function syncMember(member, options = {}) {
  if (!member || member.guild.id !== GUILD_ID || member.user.bot) return;

  return queueMember(member, async () => {
    const guild = member.guild;
    if (isProtected(guild.id, member.id)) return;
    const role = guild.roles.cache.get(ROLE_ID) || await guild.roles.fetch(ROLE_ID);
    if (!role) {
      console.error(`Role ${ROLE_ID} was not found in guild ${GUILD_ID}.`);
      return;
    }

    const hasRole = member.roles.cache.has(ROLE_ID);
    const botOwnsIt = ownsRole(guild.id, member.id);

    const presence = options.presence ?? member.presence ?? null;
    const presenceKnown = options.presenceKnown ?? Boolean(member.presence);
    const statusMatch = hasDestinyyStatus(presence);
    const tagState = getTagState(member.user, guild.id);
    const eligible = statusMatch || tagState.usingThisServerTag;

    if (eligible) {
      // If the member already had the role, it is treated as manually assigned.
      if (!hasRole) {
        await member.roles.add(role, 'Destinyy auto-role: member met a requirement');
        setOwnsRole(guild.id, member.id, true);
        console.log(`Added role to ${member.user.tag || member.id}`);
      }
      return;
    }

    // Never remove based on incomplete data. Both the presence and tag state
    // must be known before concluding that the member no longer qualifies.
    if (!presenceKnown || !tagState.known) return;

    // Only remove a role that this bot previously added and recorded.
    if (botOwnsIt && hasRole) {
      await member.roles.remove(role, 'Destinyy auto-role: member no longer meets either requirement');
      setOwnsRole(guild.id, member.id, false);
      console.log(`Removed bot-managed role from ${member.user.tag || member.id}`);
    } else if (botOwnsIt && !hasRole) {
      // The role was removed by someone else; clear stale ownership.
      setOwnsRole(guild.id, member.id, false);
    }
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error(`I cannot access server ${GUILD_ID}. Check GUILD_ID and invite the bot.`);
    return;
  }

  try {
    await guild.roles.fetch(ROLE_ID);
    const members = await guild.members.fetch();
    console.log(`Initial check: ${members.size} members.`);
    for (const member of members.values()) {
      // On startup, do not assume an uncached/offline presence means no status.
      await syncMember(member, { presenceKnown: Boolean(member.presence) });
    }
  } catch (error) {
    console.error('Initial member sync failed:', error);
  }
});

client.on(Events.PresenceUpdate, (_oldPresence, newPresence) => {
  if (newPresence.guild.id !== GUILD_ID) return;
  if (newPresence.member) {
    void syncMember(newPresence.member, {
      presence: newPresence,
      presenceKnown: true,
    });
  }
});

client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;
  void syncMember(newMember, { presenceKnown: Boolean(newMember.presence) });
});

// Some discord.js/API versions surface primary-guild changes as UserUpdate.
client.on(Events.UserUpdate, (_oldUser, newUser) => {
  const guild = client.guilds.cache.get(GUILD_ID);
  const member = guild?.members.cache.get(newUser.id);
  if (member) void syncMember(member, { presenceKnown: Boolean(member.presence) });
});

client.on(Events.GuildMemberRemove, (member) => {
  if (member.guild.id !== GUILD_ID) return;
  if (ownsRole(member.guild.id, member.id)) setOwnsRole(member.guild.id, member.id, false);
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.guild.id !== GUILD_ID || message.author.bot) return;
  const parts = message.content.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  if (![`${PREFIX}sync`, `${PREFIX}protect`, `${PREFIX}unprotect`].includes(command)) return;
  if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('You need Manage Server permission to run this.');
    return;
  }

  if (command === `${PREFIX}protect` || command === `${PREFIX}unprotect`) {
    const target = message.mentions.members.first();
    if (!target) {
      await message.reply(`Mention a member: \`${PREFIX}${command === `${PREFIX}protect` ? 'protect' : 'unprotect'} @member\``);
      return;
    }
    const protect = command === `${PREFIX}protect`;
    setProtected(GUILD_ID, target.id, protect);
    await message.reply(protect
      ? `Protected ${target.user.tag} from automatic role removal and assignment.`
      : `Protection removed for ${target.user.tag}. Checking their eligibility now.`);
    if (!protect) await syncMember(target, { presenceKnown: Boolean(target.presence) });
    return;
  }

  await message.reply('Starting a member sync. This may take a little while.');
  try {
    const members = await message.guild.members.fetch();
    for (const member of members.values()) {
      await syncMember(member, { presenceKnown: Boolean(member.presence) });
    }
    await message.channel.send(`Sync finished for ${members.size} members.`);
  } catch (error) {
    console.error('Manual sync failed:', error);
    await message.channel.send('The sync failed. Check the bot console for details.');
  }
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(TOKEN);
