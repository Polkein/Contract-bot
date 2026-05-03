const fs = require("fs");
const path = require("path");

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

const requiredEnv = [
  "TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "HIGHROLES",
  "CONTRACT_CHANNEL_ID"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Ошибка: переменная ${key} не найдена`);
    process.exit(1);
  }
}

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
const DATA_FILE = path.join(DATA_DIR, "contracts.json");

let parties = new Map();
let busyUsers = new Map();

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(DATA_FILE)) {
      saveData();
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw.trim()) return;

    const data = JSON.parse(raw);
    parties = new Map(data.parties || []);
    busyUsers = new Map(data.busyUsers || []);

    console.log("Данные контрактов загружены");
  } catch (error) {
    console.error("Ошибка загрузки данных:", error);
  }
}

function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          parties: Array.from(parties.entries()),
          busyUsers: Array.from(busyUsers.entries())
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("Ошибка сохранения данных:", error);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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
      option.setName("message_id").setDescription("ID сообщения контракта").setRequired(true)
    )
    .addUserOption(option =>
      option.setName("user").setDescription("Кого добавить").setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("contract-remove")
    .setDescription("Убрать участника из конкретного контракта")
    .addStringOption(option =>
      option.setName("message_id").setDescription("ID сообщения контракта").setRequired(true)
    )
    .addUserOption(option =>
      option.setName("user").setDescription("Кого убрать").setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("contract-reset")
    .setDescription("Снять участника с занятости, если он застрял")
    .addUserOption(option =>
      option.setName("user").setDescription("Кого освободить").setRequired(true)
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
  const allowedRoles = process.env.HIGHROLES.split(",").map(role => role.trim());
  return member.roles.cache.some(role => allowedRoles.includes(role.id));
}

function isContractChannel(interaction) {
  return interaction.channelId === process.env.CONTRACT_CHANNEL_ID;
}

function extractMessageId(input) {
  const match = input.match(/\d{17,25}$/);
  return match ? match[0] : input;
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
          .setLabel("Записаться")
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
          .setLabel("Записаться")
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
  try {
    const msg = await interaction.channel.messages.fetch(messageId);

    await msg.edit({
      embeds: [makeEmbed(party)],
      components: makeButtons(party.status)
    });

    return true;
  } catch (error) {
    console.error("Ошибка обновления сообщения контракта:", error);

    await interaction.followUp({
      content: "Не удалось обновить сообщение контракта. Проверь ID сообщения и права бота.",
      ephemeral: true
    }).catch(() => {});

    return false;
  }
}

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!isContractChannel(interaction)) {
        return interaction.reply({
          content: "Команды контрактов можно использовать только в канале #запись-на-контракты.",
          ephemeral: true
        });
      }

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
        saveData();
        return;
      }

      if (interaction.commandName === "contract-add") {
        await interaction.deferReply({ ephemeral: true });

        if (!hasHighRole(interaction.member)) {
          return interaction.editReply("Только Contract Manager может добавлять участников.");
        }

        const messageId = extractMessageId(interaction.options.getString("message_id"));
        const user = interaction.options.getUser("user");
        const party = parties.get(messageId);

        if (!party) return interaction.editReply("Контракт не найден. Проверь ID сообщения.");
        if (party.status !== "open") return interaction.editReply("Добавлять можно только пока набор открыт.");
        if (party.users.includes(user.id)) return interaction.editReply("Этот участник уже записан в этот контракт.");
        if (busyUsers.has(user.id)) return interaction.editReply("Этот участник уже находится в другом активном контракте.");
        if (party.users.length >= 4) return interaction.editReply("Мест больше нет (4/4).");

        party.users.push(user.id);
        busyUsers.set(user.id, messageId);

        const updated = await updateContractMessage(interaction, messageId, party);

        if (!updated) {
          party.users = party.users.filter(id => id !== user.id);
          busyUsers.delete(user.id);

          return interaction.editReply("Не удалось обновить сообщение контракта. Участник не был добавлен.");
        }

        saveData();

        return interaction.editReply(`Участник ${user} добавлен в контракт.`);
      }

      if (interaction.commandName === "contract-remove") {
        await interaction.deferReply({ ephemeral: true });

        if (!hasHighRole(interaction.member)) {
          return interaction.editReply("Только Contract Manager может убирать участников.");
        }

        const messageId = extractMessageId(interaction.options.getString("message_id"));
        const user = interaction.options.getUser("user");
        const party = parties.get(messageId);

        if (!party) return interaction.editReply("Контракт не найден. Проверь ID сообщения.");
        if (!party.users.includes(user.id)) return interaction.editReply("Этого участника нет в контракте.");

        const oldUsers = [...party.users];
        const wasBusyInThisContract = busyUsers.get(user.id) === messageId;

        party.users = party.users.filter(id => id !== user.id);
        busyUsers.delete(user.id);

        const updated = await updateContractMessage(interaction, messageId, party);

        if (!updated) {
          party.users = oldUsers;

          if (wasBusyInThisContract) {
            busyUsers.set(user.id, messageId);
          }

          return interaction.editReply("Не удалось обновить сообщение контракта. Участник не был убран.");
        }

        saveData();

        return interaction.editReply(`Участник ${user} убран из контракта.`);
      }

      if (interaction.commandName === "contract-reset") {
        await interaction.deferReply({ ephemeral: true });

        if (!hasHighRole(interaction.member)) {
          return interaction.editReply("Только Contract Manager может сбрасывать занятость участника.");
        }

        const user = interaction.options.getUser("user");

        busyUsers.delete(user.id);

        for (const party of parties.values()) {
          party.users = party.users.filter(id => id !== user.id);
        }

        saveData();

        return interaction.editReply(`${user} освобождён(а) от старого контракта.`);
      }
    }

    if (interaction.isButton()) {
      const party = parties.get(interaction.message.id);

      if (!party) {
        return interaction.reply({
          content: "Контракт не найден. Обратитесь к Contract Manager.",
          ephemeral: true
        });
      }

      const userId = interaction.user.id;

      if (interaction.customId === "join") {
        if (party.status !== "open") {
          return interaction.reply({ content: "Набор уже закрыт", ephemeral: true });
        }

        if (party.users.includes(userId)) {
          return interaction.reply({ content: "Ты уже записан(а)", ephemeral: true });
        }

        if (busyUsers.has(userId)) {
          return interaction.reply({
            content: "Ты уже участвуешь в другом контракте. Сначала дождись его завершения.",
            ephemeral: true
          });
        }

        if (party.users.length >= 4) {
          return interaction.reply({ content: "Мест больше нет (4/4)", ephemeral: true });
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
            content: "Только Contract Manager может закрыть набор.",
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
            content: "Только Contract Manager может закрыть контракт.",
            ephemeral: true
          });
        }

        party.status = "closed";

        for (const id of party.users) {
          busyUsers.delete(id);
        }
      }

      saveData();

      await interaction.update({
        embeds: [makeEmbed(party)],
        components: makeButtons(party.status)
      });
    }
  } catch (error) {
    console.error("Ошибка interactionCreate:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Произошла ошибка. Проверьте логи бота.",
        ephemeral: true
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "Произошла ошибка. Проверьте логи бота.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.once("clientReady", () => {
  loadData();
  console.log("Бот запущен");
});

deployCommands().then(() => {
  client.login(process.env.TOKEN);
});