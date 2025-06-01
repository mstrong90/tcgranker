const userVolumeConfig = {}; // Persist this if needed!
const awaitingSetting = {};

function getVolumeCustomizeMenu(chatId, msgId) {
  return {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "Set Buy Min", callback_data: "set_buy_min" }, { text: "Set Buy Max", callback_data: "set_buy_max" }],
        [{ text: "Set Interval Min", callback_data: "set_interval_min" }, { text: "Set Interval Max", callback_data: "set_interval_max" }],
        [{ text: "⬅️ Back", callback_data: "volume_bot_menu" }]
      ]
    }
  };
}

module.exports = { userVolumeConfig, awaitingSetting, getVolumeCustomizeMenu };
