const Usage = require("command-parser");
const o = require("../options");

let channels = new Usage({
	desription: "Commands related to managing channels"
});

let stripMentions = (msg) => {
	return msg.content
		.replace(/@(everyone|here)/g, "")
		.replace(/<@!?[0-9]+>/g, "")
		.replace(/<#!?[0-9]+>/g, "");
};

function spaceChannels({guild, from, to, msg}) {
	let channelNames = [];
	guild.channels.forEach(channel => {if(channel.name.indexOf(from) > -1) { channelNames.push(`<#${channel.id}>`); channel.setName(channel.name.split(from).join(to)).catch(e => msg.reply(`Could not space channels because I don't have permission to manage <#${channel.id}>.`)); }   });
	return channelNames.length > 10 ? `${channelNames.length} channels` : `${  channelNames.join(", ")  }.`;
}

channels.add("spacing", new Usage({
	description: "Have spaces in channel names instead of dashes",
	requirements: [o.pm(false), o.myPerm("MANAGE_CHANNELS"), o.perm("MANAGE_CHANNELS")/*o.yourPerm("MANAGE_CHANNELS")*/],
	usage: [["space", "dash"]],
	callback: async(data, yn) => {
		if(!yn) return data.msg.reply("Usage: channels spacing [space|dash]");
		switch (yn) {
			case "true":
			case "space":
			case "yes":
				return data.msg.reply(`Spaced ${spaceChannels({guild: data.msg.guild, from: `-`, to: ` `, msg: data.msg})}`);
			case "false":
			case "dash":
			case "no":
				return data.msg.reply(`Dashed ${spaceChannels({guild: data.msg.guild, to: `-`, from: ` `, msg: data.msg})}`);
			default:
				return data.msg.reply("Usage: spaceChannels [space|dash]");
		}
	}
}));

channels.add("sendMany", new Usage({
	description: "Have spaces in channel names instead of dashes",
	requirements: [o.pm(false),  o.perm("MANAGE_CHANNELS")/*o.yourPerm("MANAGE_CHANNELS")*/],
	usage: ["...message", "#channels #to #send #to"],
	callback: async(data) => {
		let message = stripMentions(data.msg).replace(/^.+channels sendMany /, ""); // TODO find a better way to do this
		let channelsToSendTo = data.msg.mentions.channels.array();
		channelsToSendTo.forEach(channel => {
			channel.send(message).catch(errorNooneCaresAbout => data.msg.reply(`Could not send to ${channel.toString()}. Maybe I don't have permission?`));
		});
		data.msg.reply(`Sent ${message} to ${channelsToSendTo.map(c => c.toString()).join`, `}`);
	}
}));


module.exports = channels;
