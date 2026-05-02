require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const parties = new Map();
const busyUsers = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("contract")
    .setDescription("Создать запись на контракт")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("contract-add")
    .setDescription("Добавить участника в конкретный контракт")
    .addStringOption(option =>
      option
        .setName("message_id")
        .setDescription("ID сообщения контракта")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Кого добавить")
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("contract-remove")
    .setDescription("Убрать участника из конкретного контракта")
    .addStringOption(option =>
      option
        .setName("message_id")
        .setDescription("ID сообщения контракта")
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Кого убрать")
        .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

async function deployCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("Команды зарегистрированы");
}

function hasHighRole(member) {
  const allowedRoles = process.env.HIGHROLES.split(",");
  return member.roles.cache.some(role => allowedRoles.includes(role.id));
}

function makeEmbed(party) {
  let statusText = "";

  if (party.status === "open") statusText = "🟢 Набор открыт";
  if (party.status === "running") statusText = "🟡 Контракт идёт";
  if (party.status === "closed") statusText = "🔴 Контракт закрыт";

  return new EmbedBuilder()
    .setTitle("🎯 Контракт")
    .setDescription(
      `**Статус:** ${statusText}\n` +
      `**Участники:** ${party.users.length}/4\n\n` +
      (party.users.length
        ? party.users.map((u, i) => `${i + 1}. <@${u}>`).join("\n")
        : "Пока никто не записан") +
      "\n\nМинимум для старта: 2 участника"
    );
}

function makeButtons(status) {
  if (status === "open") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("join")
          .setLabel("Войти")
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId("leave")
          .setLabel("Выйти")
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId("start")
          .setLabel("Закрыть набор")
          .setStyle(ButtonStyle.Primary)
      )
    ];
  }

  if (status === "running") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("join_disabled")
          .setLabel("Войти")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),

        new ButtonBuilder()
          .setCustomId("leave_disabled")
          .setLabel("Выйти")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),

        new ButtonBuilder()
          .setCustomId("finish")
          .setLabel("Закрыть контракт")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("closed")
        .setLabel("Контракт закрыт")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    )
  ];
}

async function updateContractMessage(interaction, messageId, party) {
  const channel = interaction.channel;
  const msg = await channel.messages.fetch(messageId);

  await msg.edit({
    embeds: [makeEmbed(party)],
    components: makeButtons(party.status)
  });
}

client.on("interactionCreate", async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "contract") {
      const party = {
        users: [],
        status: "open"
      };

      const msg = await interaction.reply({
        embeds: [makeEmbed(party)],
        components: makeButtons(party.status),
        fetchReply: true
      });

      parties.set(msg.id, party);
      return;
    }

    if (interaction.commandName === "contract-add") {
      if (!hasHighRole(interaction.member)) {
        return interaction.reply({
          content: "Только старший может добавлять участников",
          ephemeral: true
        });
      }

      const messageId = interaction.options.getString("message_id");
      const user = interaction.options.getUser("user");
      const party = parties.get(messageId);

      if (!party) {
        return interaction.reply({
          content: "Контракт не найден. Проверь ID сообщения.",
          ephemeral: true
        });
      }

      if (party.status !== "open") {
        return interaction.reply({
          content: "Добавлять можно только пока набор открыт.",
          ephemeral: true
        });
      }

      if (party.users.includes(user.id)) {
        return interaction.reply({
          content: "Этот участник уже записан в этот контракт.",
          ephemeral: true
        });
      }

      if (busyUsers.has(user.id)) {
        return interaction.reply({
          content: "Этот участник уже находится в другом активном контракте.",
          ephemeral: true
        });
      }

      if (party.users.length >= 4) {
        return interaction.reply({
          content: "Мест больше нет (4/4).",
          ephemeral: true
        });
      }

      party.users.push(user.id);
      busyUsers.set(user.id, messageId);

      await updateContractMessage(interaction, messageId, party);

      return interaction.reply({
        content: `Участник ${user} добавлен в контракт.`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "contract-remove") {
      if (!hasHighRole(interaction.member)) {
        return interaction.reply({
          content: "Только старший может убирать участников",
          ephemeral: true
        });
      }

      const messageId = interaction.options.getString("message_id");
      const user = interaction.options.getUser("user");
      const party = parties.get(messageId);

      if (!party) {
        return interaction.reply({
          content: "Контракт не найден. Проверь ID сообщения.",
          ephemeral: true
        });
      }

      if (!party.users.includes(user.id)) {
        return interaction.reply({
          content: "Этого участника нет в контракте.",
          ephemeral: true
        });
      }

      party.users = party.users.filter(id => id !== user.id);
      busyUsers.delete(user.id);

      await updateContractMessage(interaction, messageId, party);

      return interaction.reply({
        content: `Участник ${user} убран из контракта.`,
        ephemeral: true
      });
    }
  }

  if (interaction.isButton()) {
    const party = parties.get(interaction.message.id);
    if (!party) return;

    const userId = interaction.user.id;

    if (interaction.customId === "join") {
      if (party.status !== "open") {
        return interaction.reply({
          content: "Набор уже закрыт",
          ephemeral: true
        });
      }

      if (party.users.includes(userId)) {
        return interaction.reply({
          content: "Ты уже записан(а)",
          ephemeral: true
        });
      }

      if (busyUsers.has(userId)) {
        return interaction.reply({
          content: "Ты уже участвуешь в другом контракте. Сначала дождись его завершения.",
          ephemeral: true
        });
      }

      if (party.users.length >= 4) {
        return interaction.reply({
          content: "Мест больше нет (4/4)",
          ephemeral: true
        });
      }

      party.users.push(userId);
      busyUsers.set(userId, interaction.message.id);
    }

    if (interaction.customId === "leave") {
      if (party.status !== "open") {
        return interaction.reply({
          content: "Нельзя выйти: набор уже закрыт",
          ephemeral: true
        });
      }

      party.users = party.users.filter(id => id !== userId);
      busyUsers.delete(userId);
    }

    if (interaction.customId === "start") {
      if (!hasHighRole(interaction.member)) {
        return interaction.reply({
          content: "Только старший может закрыть набор",
          ephemeral: true
        });
      }

      if (party.users.length < 2) {
        return interaction.reply({
          content: "Нужно минимум 2 участника",
          ephemeral: true
        });
      }

      party.status = "running";
    }

    if (interaction.customId === "finish") {
      if (!hasHighRole(interaction.member)) {
        return interaction.reply({
          content: "Только старший может закрыть контракт",
          ephemeral: true
        });
      }

      party.status = "closed";

      for (const id of party.users) {
        busyUsers.delete(id);
      }
    }

    await interaction.update({
      embeds: [makeEmbed(party)],
      components: makeButtons(party.status)
    });
  }
});

client.once("clientReady", () => {
  console.log("Бот запущен");
});

deployCommands().then(() => {
  client.login(process.env.TOKEN);
});