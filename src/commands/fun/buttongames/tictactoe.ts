import * as nr from "../../../NewRouter";
import {globalKnex} from "../../../db";
import client from "../../../../bot";
import Info, {permTheyCanManageRole, permWeCanManageRole} from "../../../Info";
import { InteractionHandled } from "../../../SlashCommandManager";
import { globalConfig } from "../../../config";

const BasicKeys = {
    joining: {join: "join", end: "end", join_anyway: "join_anyway"},
    playing: {give_up: "give_up"},
};

type ApiHandler = {
    get: <T>() => Promise<T>;
    post: <T, Q>(value: T) => Promise<Q>;
    patch: (value: any) => Promise<any>;
    delete: () => Promise<any>;
} & {[key: string]: ApiHandler} & ((...data: any[]) => ApiHandler);

type ApiHolder = {api: ApiHandler};

type ButtonComponent = {
	type: 2;
	style: 1 | 2 | 3 | 4; // primary, primary (green), secondary, destructive (red)
	label?: string;
	custom_id: string; // max 100 chars
	disabled?: boolean;
	emoji?: {name: string; id: string; animated: boolean};
} | {
	type: 2;
	style: 5; // URL
	label: string;
	url: string;
	disabled: boolean;
} | {
    type: 3;
    label: string;
    style: 1;
    custom_id: string;
    options: {value: string; label: string}[];
};

const buttonStyles = {
	primary: 1,
	secondary: 2,
	accept: 3,
	deny: 4,
} as const;
type ButtonStyle = keyof typeof buttonStyles;

type ExtraButtonOpts = {
	disabled?: boolean;
	emoji?: {name: string; id: string; animated: boolean};
};

function button(id: string, label: string | undefined, style: ButtonStyle, opts: ExtraButtonOpts): ButtonComponent {
	if(id.length > 100) throw new Error("bad id");
	return {
		type: 2,
		style: buttonStyles[style],
		label: label,
		custom_id: id,
		...opts,
	};
}

type ActionRow = {type: 1; components: ButtonComponent[]};
function componentRow(children: ButtonComponent[]): ActionRow {
    if(children.length > 5) throw new Error("too many buttons");
	return {type: 1, components: children};
}

type SampleMessage = {
	content: string;
	components: ActionRow[];
    allowed_mentions: {parse: []},
};

nr.globalCommand(
	"/help/test/spooky",
	"spooky",
	{
		usage: "spooky",
		description: "spooky",
		examples: [],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const api = info.message.client as any as ApiHolder;
		await api.api.channels(info.message.channel.id).messages.post<{data: SampleMessage}, unknown>({data: {
			content: "spooky",
			components: [
				componentRow([
                    button("boo_btn", "Boo!", "primary", {}),
				]),
                componentRow([
                    {type: 3, style: 1, label: "Down", custom_id: "dropdown", options: [
                        {value: "one", label: "One"},
                        {value: "two", label: "Two"},
                    ]},
                ]),
			],
            allowed_mentions: {parse: []},
		}});
	},
);

nr.ginteractionhandler["boo_btn"] = {
    async handle(info, custom_id) {
        if(info.raw_interaction) {
            await info.raw_interaction.replyHiddenHideCommand("👻");
        }
    }
};

type GameData = {
    kind: GameKind;
    state: unknown;
    stage: number;
};

type GameID = string & {__is_game_id?: undefined};
function numToGameID(num: number): GameID {
    return num.toString(36) as GameID;
}
function gameIDToNum(game_id: GameID): number {
    return parseInt(game_id, 36);
}

type InteractionKey = `GAME|${GameID}|${GameKind}|${number}|${string}`; // ID|KIND|STAGE|NAME
function getInteractionKey(id: GameID, kind: GameKind, stage: number, name: string): InteractionKey {
    //eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const res: InteractionKey = `GAME|${id}|${kind}|${stage}|${name}`;
    if(res.length > 100) throw new Error("interaction key too long");
    return res;
}
function parseInteractionKey(key: InteractionKey): {game_id: GameID; kind: GameKind; stage: number; name: string} {
    const [, a, b, c, d] = key.split("|") as [string, string, string, string, string];
    return {
        game_id: a as GameID,
        kind: b as GameKind,
        stage: +c,
        name: d,
    };
}

async function createGame<T>(game_kind: GameKind, game_state: T) {
    const gd: GameData = {
        kind: game_kind,
        state: game_state,
        stage: 0,
    };
	const [id] = await globalKnex!("games").insert({
        id: undefined,
        data: JSON.stringify(gd),
    }).returning("id");

    return numToGameID(id);
}
async function getGameData(game_id: GameID): Promise<GameData> {
    const res = await globalKnex!("games").where({id: gameIDToNum(game_id)});
    const rd = res[0].data;
    if(typeof rd !== "string") return rd;
    return JSON.parse(rd);
}

async function renderGame(info: Info, game_id: GameID) {
    const game_data = await getGameData(game_id);

    const api = client as any as ApiHolder;
    await api.api.channels(info.message.channel.id).messages.post<{data: SampleMessage}, unknown>({data:
        games[game_data.kind].render(game_data.state, game_id, game_data.kind, game_data.stage, info),
    });
}

interface Game<T> {
    render: (state: T, game_id: GameID, game_kind: GameKind, game_stage: number, info: Info) => SampleMessage;
    handleInteraction: (info: Info, custom_id: string) => Promise<InteractionHandled<T>>;
};

// TODO rather than incrementing stage, generate a random id
// this will prevent a race condition when two buttons are clicked
// at the same time and both fetch from the db before the db is updated by either.
// actually it shouldn't matter too much, the only invalid state will be in what buttons are
// visible and that's fine

async function updateGameState<T>(info: Info, ikey: {game_id: GameID; kind: GameKind; stage: number}, state: T): Promise<InteractionHandled<T>> {
    // get new game data
    const upd_game_data: GameData = {kind: ikey.kind, stage: ikey.stage + 1, state: state};
    // 1: send updated message    
    
    const msgv = games[upd_game_data.kind].render(upd_game_data.state, ikey.game_id, upd_game_data.kind, upd_game_data.stage, info);
    if(info.raw_interaction) {
        await info.raw_interaction.sendRaw({
            type: 7,
            data: {...msgv, allowed_mentions: {parse: []}},
        });
    }else{
        await info.accept();
        const api = client as any as ApiHolder;
        await api.api.channels(info.message.channel.id).messages.post<{data: SampleMessage}, unknown>({data:
            msgv
        });
    }

    // 2: accept interaction
    // await info.accept();
    // TODO use interactions rather than info.accept()
    // 3: update in db
    await globalKnex!("games").where({id: gameIDToNum(ikey.game_id)}).update({data: JSON.stringify(upd_game_data)});
    // return handle token
    return {__interaction_handled: true as unknown as T};
}
async function errorGame(info: Info, message: string): Promise<InteractionHandled<any>> {
    await info.error(message);
    return {__interaction_handled: true};
}

type Grid<T> = T[][];

type TicTacToeState = {
	mode: "joining";
	first_player: string;
} | {
	mode: "playing" | "won";
	board: {grid: Grid<" " | "O" | "X">};
	player: "O" | "X";
	players: {
		"O": string;
		"X": string;
	};
    win?: {
        player: "X" | "O" | "Tie",
        reason: string,
    },
} | {
    mode: "canceled",
    initiator: string;
};
function gridSearch<GT>(grid: Grid<GT>, start: [number, number],
    cb: (
        tile: GT,
        x: number,
        y: number,
    ) => [number, number] | "current" | "previous",
): { x: number; y: number; distance: number } | undefined {
    let [cx, cy] = start;
    let [x, y] = start;
    const w = grid[0]!.length;
    const h = grid.length;
    let i = 0;
    while (true) {
        if (i > 1000)
            throw new Error("Potentially infinite find!:(passed 1000)");
        const result =
            cx >= w || cx < 0 || cy >= h || cy < 0
                ? "previous" // search will now automatically end when off board
                : cb(grid[cy][cx], cx, cy);
        if (result === "previous")
            if (i === 0) return undefined;
            else return { x, y, distance: i };
        [x, y] = [cx, cy];
        i++;
        if (result === "current") return { x, y, distance: i };
        [cx, cy] = result;
    }
}
function tttDetectWin(grid: Grid<" " | "O" | "X">, placedX: number, placedY: number): boolean {
	const checks: [number, number][] = [
		[-1, -1],
		[-1, 0],
		[-1, 1],
		[0, -1],
	];
	const tile = grid[placedY][placedX];
	if (tile === " ") throw new Error("checkWin called at invalid location");
	for (const check of checks) {
		const downmost = gridSearch(grid,
			[placedX, placedY],
			(tileh, x, y) => {
				if (tileh !== tile) return "previous";
				return [x + check[0], y + check[1]];
			},
		);
		if (!downmost) throw new Error("tile was not found but it must be");
		const upmost = gridSearch(grid,
			[downmost.x, downmost.y],
			(tileh, x, y) => {
				if (tileh !== tile) return "previous";
				return [x - check[0], y - check[1]];
			},
		);
		if (!upmost) throw new Error("tile was not found but it must be 2");
		if (upmost.distance >= 3) return true;
	}
	return false;
}
function tttDetectTie(grid: Grid<" " | "O" | "X">): boolean {
    return grid.every(l => l.every(t => t !== " "));
}

const TTTGame: Game<TicTacToeState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.first_player+"> is starting a game of Tic Tac Toe",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing" || state.mode === "won") {
            return {
                content: state.mode === "playing"
                    ? "It's your turn <@"+state.players[state.player]+">, You are "+state.player
                    : state.mode === "won"
                    ? state.win
                    ? (state.win.player === "Tie"
                    ? "There was a tie. "
                    : "<@"+state.players[state.win.player]+"> won!")
                    + " ("+state.win.reason+"). Players: X <@"+state.players.X+">, O: <@"+state.players.O+">"
                    : "Someone won but I'm not sure who."
                    : "never",
                components: [
                    ...state.board.grid.map((yr, y) => componentRow(
                        yr.map((tile, x) =>
                            button(key("T,"+x+","+y), tile, ({" ": "secondary", "X": "primary", "O": "accept"} as const)[tile], {}),
                        )
                    )),
                    ...state.mode === "playing" ?
                    [componentRow([
                        button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                    ])] : [],
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled"){
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<TicTacToeState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as TicTacToeState;

        console.log(game_state);

        if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.first_player) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as unknown as TicTacToeState};
                }else{
                    return await updateGameState<TicTacToeState>(info, ikey, {
                        mode: "playing",
                        // initiator: state.first_player,
                        board: {grid:
                            [
                                [" ", " ", " "],
                                [" ", " ", " "],
                                [" ", " ", " "],
                            ]
                        },
                        player: "X",
                        players: {
                            "X": state.first_player,
                            "O": info.message.author.id,
                        },
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.first_player) {
                    return await updateGameState<TicTacToeState>(info, ikey, {
                        mode: "canceled",
                        initiator: state.first_player,
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.first_player+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(info.message.author.id !== state.players[state.player]) {
                if(!JSON.stringify(state.player).includes(info.message.author.id)) { // hack
                    return await errorGame(info, "You're not in this game");
                }
                return await errorGame(info, "It's not your turn");
            }
            if(ikey.name.startsWith("T,")) {
                const [, tx, ty] = ikey.name.split(",") as [string, string, string];
                if(state.board.grid[+ty]![+tx] !== " ") return await errorGame(info, "You must click an empty tile");
                state.board.grid[+ty]![+tx] = state.player;
                if(tttDetectWin(state.board.grid, +tx, +ty)) {
                    return await updateGameState<TicTacToeState>(info, ikey, {
                        ...state,
                        mode: "won",
                        win: {
                            player: state.player,
                            reason: "Three in a row",
                        },
                    });
                }else if(tttDetectTie(state.board.grid)) {
                    return await updateGameState<TicTacToeState>(info, ikey, {
                        ...state,
                        mode: "won",
                        win: {
                            player: "Tie",
                            reason: "All spaces filled",
                        },
                    });
                }
                return await updateGameState<TicTacToeState>(info, ikey, {
                    ...state,
                    mode: "playing",
                    player: advanceTTTPlayer(state.player),
                });
            }else if(ikey.name === BasicKeys.playing.give_up) {
                return await updateGameState<TicTacToeState>(info, ikey, {
                    ...state,
                    mode: "won",
                    win: {
                        player: advanceTTTPlayer(state.player),
                        reason: "Other player gave up.",
                    },
                });
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "won") {
            return await errorGame(info, "This game is over.");
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }

        // if(info.raw_interaction) {
        //     await info.raw_interaction.replyHiddenHideCommand("Interaction "+custom_id);
        // }

        // if(info.raw_interaction) {
        //     await info.raw_interaction.accept();
        // }
    }
};
function advanceTTTPlayer(player: "X" | "O"): "O" | "X" {
    return ({"X": "O", "O": "X"} as const)[player];
}

nr.ginteractionhandler["GAME"] = {
    async handle(info, custom_id) {
        const ikey = parseInteractionKey(custom_id);
        await games[ikey.kind].handleInteraction(info, custom_id);
    }
};

nr.globalCommand(
	"/help/fun/tictactoe",
	"tictactoe",
	{
		usage: "tictactoe",
		description:
			"Play a game of tic tac toe.",
		extendedDescription: `To play tic tac toe, try to make 3 in a row on your turn.`,
		examples: [
			{
				in: "tictactoe",
				out: "{Screenshot|https://i.imgur.com/VL8fihL.png}",
			},
		],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const game_id = await createGame<TicTacToeState>("TTT", {mode: "joining", first_player: info.message.author.id});
        await renderGame(info, game_id);
	},
);
nr.globalAlias("tictactoe", "knots and crosses");
nr.globalAlias("tictactoe", "knotsandcrosses");
nr.globalAlias("tictactoe", "tic tac toe");
nr.globalAlias("tictactoe", "ticktactoe");
nr.globalAlias("tictactoe", "tick tac toe");
nr.globalAlias("tictactoe", "tick tack toâ€™");
nr.globalAlias("tictactoe", "ttt");

nr.ginteractionhandler["GRANTROLE"] = {
    async handle(info, custom_id) {
        const [, role_id] = custom_id.split("|");
        let adding_role = true;
        try {
            if(info.member!.roles.cache.has(role_id)) {
                adding_role = false;
                await info.member!.roles.remove(role_id);
            }else{
                await info.member!.roles.add(role_id);
            }
        }catch(e) {
            console.log(e);
            if(info.raw_interaction) {
                await info.raw_interaction.replyHiddenHideCommand("<:failure:508841130503438356> There was an error "+
                    (adding_role ? "giving you" : "removing")+" the role <@&"+role_id+">")
                ;
                return;
            }
        }
        if(info.raw_interaction) {
            await info.raw_interaction.replyHiddenHideCommand(
                (adding_role ? "<:success:508840840416854026> Given" : "<:info:508842207089000468> Removed")+" role <@&"+role_id+">"
            );
        }
        return;
    }
};

nr.globalCommand(
	"/help/test/grantrolebtn",
	"grantrolebtn",
	{
		usage: "grantrolebtn",
		description: "grantrolebtn `button text` <role>",
		examples: [],
		perms: {runner: ["manage_bot"]},
	},
	nr.list(nr.a.backtick(), ...nr.a.role()),
	async ([word, role], info) => {
        if(!await permTheyCanManageRole(role, info)) return;
        if(!await permWeCanManageRole(role, info)) return;

		const api = info.message.client as any as ApiHolder;
		await api.api.channels(info.message.channel.id).messages.post<{data: SampleMessage}, unknown>({data: {
			content: "​",
			components: [
				componentRow([
                    button("GRANTROLE|"+role.id, word, "primary", {}),
				]),
			],
            allowed_mentions: {parse: []},
		}});
	},
);

nr.globalCommand(
	"/help/test/createticketbtn",
	"createticketbtn",
	{
		usage: "createticketbtn",
		description: "createticketbtn `Ticket message`",
		examples: [],
		perms: {runner: ["manage_bot"]},
	},
	nr.list(nr.a.backtick()),
	async ([word], info) => {
		const api = info.message.client as any as ApiHolder;
		await api.api.channels(info.message.channel.id).messages.post<{data: SampleMessage}, unknown>({data: {
			content: "​",
			components: [
				componentRow([
                    button("CREATETICKET", word, "primary", {}),
				]),
			],
            allowed_mentions: {parse: []},
		}});
	},
);

type Circle = "O" | "X" | " ";
type CirclegameState = {
    mode: "joining",
    initiator: string,
} | {
    mode: "playing",
    over?: {
        winner: "O" | "X" | "Tie",
        reason: string,
    },
    lines: Circle[][],
    player: "O" | "X",
    players: {
        "O": string,
        "X": string,
    },
    // ooo! change the colors of the removed circles based on
    // who removed them! that'd be neat
} | {
    mode: "canceled",
} | {mode: "__never__"};
const CGGame: Game<CirclegameState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.initiator+"> is starting a circle game",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing") {
            return {
                content: !state.over
                    ? "It's your turn <@"+state.players[state.player]+">\n"
                    + "Try to be the last player to take a circle."
                    : (state.over.winner === "Tie"
                    ? "There was a tie. ("+state.over.reason+"). "
                    : "<@"+state.players[state.over.winner]+"> won!")
                    + " ("+state.over.reason+"). Players: <@"+state.players.X+">, <@"+state.players.O+">",
                components: [
                    ...state.lines.map((yr, y) => {
                        const vc = yr.filter(itm => itm === " ").length;
                        return componentRow([
                            ...yr.map((tile, x) =>
                                button(key("C,"+(vc - x)+","+y), tile === " " ? "" + (vc - x) : " ",
                                    ({" ": "secondary", "X": "primary", "O": "accept"} as const)[tile],
                                    {disabled: tile === " " ? false : true},
                                ),
                            ),
                            ...y == 0 && !state.over ?
                            [
                                button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                            ] : [],
                        ]);
                    }),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled") {
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<CirclegameState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as CirclegameState;

        console.log(game_state);

        if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.initiator) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as any};
                }else{
                    return await updateGameState<CirclegameState>(info, ikey, {
                        mode: "playing",
                        lines: [
                            [" "],
                            [" ", " "],
                            [" ", " ", " "],
                            [" ", " ", " ", " "],
                            [" ", " ", " ", " ", " "],
                        ],
                        player: "X",
                        players: {
                            "X": state.initiator,
                            "O": info.message.author.id,
                        },
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.initiator) {
                    return await updateGameState<CirclegameState>(info, ikey, {
                        mode: "canceled",
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.initiator+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(state.over) return await errorGame(info, "This game is over.");
            if(info.message.author.id !== state.players[state.player]) {
                if(!JSON.stringify(state.player).includes(info.message.author.id)) { // hack
                    return await errorGame(info, "You're not in this game");
                }
                return await errorGame(info, "It's not your turn");
            }
            if(ikey.name.startsWith("C,")) {
                const [, tc, ty] = ikey.name.split(",") as [string, string, string];

                const line = state.lines[+ty];
                let index = line.lastIndexOf(" ") + 1;
                for(let i = Math.max(0, index -+ tc); i < index; i++){
                    line[i] = state.player;
                }

                if(state.lines.every(line => line.lastIndexOf(" ") === -1)) {
                    return await updateGameState<CirclegameState>(info, ikey, {
                        ...state,
                        over: {
                            winner: state.player,
                            reason: "Took the last circle",
                        },
                    });
                }

                return await updateGameState<CirclegameState>(info, ikey, {
                    ...state,
                    player: advanceCGPlayer(state.player),
                });
                return await errorGame(info, "TODO: "+tc+", "+ty);
            }else if(ikey.name === BasicKeys.playing.give_up) {
                return await updateGameState<CirclegameState>(info, ikey, {
                    ...state,
                    mode: "playing",
                    over: {
                        winner: advanceCGPlayer(state.player),
                        reason: "Other player gave up.",
                    },
                });
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }

        // if(info.raw_interaction) {
        //     await info.raw_interaction.replyHiddenHideCommand("Interaction "+custom_id);
        // }

        // if(info.raw_interaction) {
        //     await info.raw_interaction.accept();
        // }
    }
};
function advanceCGPlayer(player: "X" | "O"): "O" | "X" {
    return ({"X": "O", "O": "X"} as const)[player];
}

nr.globalCommand(
	"/help/fun/circlegame",
	"circlegame",
	{
		usage: "circlegame",
		description:
			"Play a game of circlegame.",
		examples: [
			{
				in: "circlegame",
				out: "{Screenshot|https://i.imgur.com/HW7Pxh6.png}",
			},
		],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const game_id = await createGame<CirclegameState>("CG", {mode: "joining", initiator: info.message.author.id});
        await renderGame(info, game_id);
	},
);
nr.globalAlias("circlegame", "circle game");


nr.globalCommand(
	"/help/fun/papersoccer",
	"papersoccer",
	{
		usage: "papersoccer",
		description:
			"Play a game of paper soccer.",
		extendedDescription: `To play paper soccer, try to get the ball into the opponent's goal.
You cannot move in a line that has already been drawn.
If you move somewhere that already has lines going from it, you get to move again.

Alternative spellings are accepted, including {Command|paper football}`,
		examples: [
			{
				in: "papersoccer",
				out: "{Screenshot|https://i.imgur.com/FNnudZ6.png}",
			},
		],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const api = info.message.client as any as ApiHolder;

		const game_id = await createGame<PSState>("PS", {mode: "joining", initiator: info.message.author.id});
        await renderGame(info, game_id);
	},
);
nr.globalAlias("papersoccer", "paper soccer");
nr.globalAlias("papersoccer", "paper football");
nr.globalAlias("papersoccer", "paperfootball");
nr.globalAlias("papersoccer", "soccer");
nr.globalAlias("papersoccer", "football");

import * as PS from "../gamelib/papersoccer";

type PSState = {mode: "joining", initiator: string} | {mode: "canceled"} | {
    mode: "playing";

	board: PS.Board;
	players: string[];
	player: number;
	ball: [number, number];
    over?: {
        reason: string;
    },
} | {mode: "__never__"};

const PSKeys = {
    playing: {
        rules: "rules",
    },
};
const PSGame: Game<PSState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.initiator+"> is starting a paper soccer game",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing") {
            const index = PS.xyToPtIndex(...state.ball);
            const point = state.board.points[index];

            const rulesbtn = button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}});

            return {
                content: PS.displayBoard(state.board, state.ball, !!state.over, state.players[state.player], state.player === 1),
                components: state.over ? [componentRow([rulesbtn])] : [
                    ...[[..."↖↑↗"], [..."← →"], [..."↙↓↘"]].map((itm, y) => 
                        componentRow(itm.map((v, x) => {
                            if(v === " ") return button(key("none"), v, "secondary", {disabled: true});
                            const dirxn = (["a", "b", "c"][x])+(["a", "b", "c"][y]) as PS.Direction;
                            const conxn = point.connections[dirxn];

                            return button(key("MOVE,"+dirxn), v, "secondary", {disabled: conxn ? state.board.connections[conxn.active] : true});
                        })),
                    ),
                    componentRow([
                        rulesbtn,
                        button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled") {
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<PSState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as PSState;

        console.log(game_state);

        if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.initiator) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as any};
                }else{
                    return await updateGameState<PSState>(info, ikey, {
                        mode: "playing",

                        board: PS.initBoard(),
                        player: 0,
                        players: [state.initiator, info.message.author.id],
                        ball: [5, 7],
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.initiator) {
                    return await updateGameState<PSState>(info, ikey, {
                        mode: "canceled",
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.initiator+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(ikey.name === PSKeys.playing.rules) {
                if(info.raw_interaction) {
                    await info.raw_interaction.replyHiddenHideCommand(
                        "== **Paper Soccer** ==\n"+
                        "⬆️ <@"+state.players[0]+"> wins by getting the ball to the **top** of the screen.\n"+
                        "⬇️ <@"+state.players[1]+"> wins win by getting the ball to the **bottom** of the screen.\n"+
                        "You cannot move across a line that has already been drawn.\n"+
                        "If the location you move to already has a line, you get to keep going.\n"+
                        "If you get the ball stuck, your opponent wins."+(state.over ? "\n"+
                        "\n"+
                        "This game is over. <@"+state.players[state.player]+"> won ("+state.over.reason+")" : "")
                    );
                }else{
                    await info.accept();
                }
                return {__interaction_handled: true as any};
            }
            if(state.over) return await errorGame(info, "This game is over.");
            if(info.message.author.id !== state.players[state.player]) {
                if(!JSON.stringify(state.player).includes(info.message.author.id)) { // hack
                    return await errorGame(info, "You're not in this game");
                }
                return await errorGame(info, "It's not your turn");
            }
            if(ikey.name === BasicKeys.playing.give_up) {
                // other player wins
                state.player += 1;
                state.player %= state.players.length;
                state.over = {
                    reason: "Other player gave up",
                };
                return await updateGameState<PSState>(info, ikey, state);
            }
            if(ikey.name.startsWith("MOVE,")) {
                const dirxn = ikey.name.split(",")[1]! as PS.Direction;
                
                const index = PS.xyToPtIndex(...state.ball);
                const point = state.board.points[index];
                const conxn = point.connections[dirxn];

                if(!conxn) return await errorGame(info, "You can't go off the edge of the board");

                const [ofstx, ofsty] = PS.directionToDiff(dirxn);
                state.ball[0] += ofstx;
                state.ball[1] += ofsty;
                const conxnCnt = PS.availableConnections({board: state.board}, ...state.ball);
                if(state.board.connections[conxn.active]) return await errorGame(info, "You can't go over a line");
                state.board.connections[conxn.active] = true;
                if(state.ball[1] === 1) {
                    // p0 wins
                    state.player = 0;
                    state.over = {
                        reason: "Got in goal",
                    };
                } else if(state.ball[1] === 13) {
                    // p1 wins
                    state.player = 1;
                    state.over = {
                        reason: "Got in goal",
                    };
                } else if(conxnCnt === "all") {
                    // next turn
                    state.player += 1;
                    state.player %= state.players.length;
                }else if(conxnCnt === "none") {
                    // other player wins
                    state.player += 1;
                    state.player %= state.players.length;
                    state.over = {
                        reason: "Other player was unable to move",
                    };
                }else{
                    // current player goes again
                }
                return await updateGameState<PSState>(info, ikey, state);
            }
            return await errorGame(info, "TODO move: "+ikey.name+".");
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }
    }
};

type CalcOp = "+" | "-" | "×" | "÷" | "^";
type CalcState = {
    current: string,
    previous?: {
        operation: CalcOp,
        number: string,
    },
    before_eq?: {
        operation: CalcOp,
        lhs: string,
        number: string,
    },
};

nr.globalCommand(
	"/help/test/calculator",
	"calculator",
	{
		usage: "calculator",
		description: "calculator",
		examples: [],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const api = info.message.client as any as ApiHolder;

		const game_id = await createGame<CalcState>("CALC", {
            current: "",
        });
        await renderGame(info, game_id);
	},
);
const Calculator: Game<CalcState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        const currentText = (state.current || "0");
        let renderedCalculator = (state.previous ? state.previous.number + " " + state.previous.operation + " " : "")
            + currentText
        ;
        if(state.previous && state.previous.operation === "^" && state.current.match(/^[0-9.]+$/)) {
            renderedCalculator = state.previous.number + [...currentText].map(c => c === "." ? "·" : [..."⁰¹²³⁴⁵⁶⁷⁸⁹"][+c]).join("");
        }
        if(state.before_eq) {
            renderedCalculator = "= " + renderedCalculator;
            if(!state.previous) {
                renderedCalculator = state.before_eq.operation + " " + state.before_eq.number + " " + renderedCalculator;
            }
        }
        const operations_enabled = !!state.current;
        const eq_enabled = calculate(JSON.parse(JSON.stringify(state)));
        return {
            content: "```\n"+renderedCalculator+"\n```",
            components: [
                componentRow([
                    button(key("O,^"), "xʸ", "secondary", {disabled: !operations_enabled}),
                    button(key("negative"), "±", "secondary", {}),
                    button(key("bksp"), "⌫", "secondary", {}),
                    button(key("ac"), "AC", "deny", {}),
                ]),
                componentRow([
                    button(key("I,7"), "7", "secondary", {}),
                    button(key("I,8"), "8", "secondary", {}),
                    button(key("I,9"), "9", "secondary", {}),
                    button(key("O,÷"), "÷", "secondary", {disabled: !operations_enabled}),
                ]),
                componentRow([
                    button(key("I,4"), "4", "secondary", {}),
                    button(key("I,5"), "5", "secondary", {}),
                    button(key("I,6"), "6", "secondary", {}),
                    button(key("O,×"), "×", "secondary", {disabled: !operations_enabled}),
                ]),
                componentRow([
                    button(key("I,1"), "1", "secondary", {}),
                    button(key("I,2"), "2", "secondary", {}),
                    button(key("I,3"), "3", "secondary", {}),
                    button(key("O,-"), "-", "secondary", {disabled: !operations_enabled}),
                ]),
                componentRow([
                    button(key("I,0"), "0", "secondary", {}),
                    button(key("I,."), ".", "secondary", {disabled: state.current.includes(".")}),
                    button(key("eq"), "=", eq_enabled ? "primary" : "secondary", {disabled: !eq_enabled}),
                    button(key("O,+"), "+", "secondary", {disabled: !operations_enabled}),
                ]),
            ],
            allowed_mentions: {parse: []},
        };
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<CalcState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as CalcState;

        console.log(game_state);

        if(ikey.name.startsWith("I,")) {
            const insert = ikey.name.replace("I,", "");
            state.current += insert;
            return await updateGameState<CalcState>(info, ikey, state);
        }else if(ikey.name.startsWith("O,")) {
            const op = ikey.name.replace("O,", "");
            if(state.previous) {
                if(!calculate(state)) return await errorGame(info, "Never.");
            }
            state.previous = {
                operation: op as any,
                number: state.current,
            };
            state.current = "";
            return await updateGameState<CalcState>(info, ikey, state);
        }else if(ikey.name === "ac") {
            state.before_eq = undefined;
            state.previous = undefined;
            state.current = "";
            return await updateGameState<CalcState>(info, ikey, state);
        }else if(ikey.name === "bksp") {
            if(!state.current) {
                if(state.previous) {
                    state.current = state.previous.number;
                    state.previous = undefined;
                }else{
                    if(state.before_eq) {
                        state.current = state.before_eq.number;
                        state.previous = {number: state.before_eq.lhs, operation: state.before_eq.operation};
                        state.before_eq = undefined;
                    }
                }
            }else{
                state.current = state.current.substr(0, state.current.length - 1);
            }
            return await updateGameState<CalcState>(info, ikey, state);
        }else if(ikey.name === "eq") {
            if(!calculate(state)) return await errorGame(info, "Cannot = nothing");

            // state.before_eq = {
            //     operation: prev.operation,
            //     lhs: state.current,
            //     number: prev.number,
            // };

            return await updateGameState<CalcState>(info, ikey, state);
        }else if(ikey.name === "negative") {
            if(state.current.includes("-")) {
                state.current = state.current.replace("-", "");
            }else{
                state.current = "-" + state.current;
            }
            return await updateGameState<CalcState>(info, ikey, state);
        } else return await errorGame(info, "TODO support "+ikey.name);
    }
};

function calculateValue(lhs_str: string, op: CalcOp, rhs_str: string): number {
    const lhs =+ lhs_str;
    const rhs =+ rhs_str;

    if(op === "+") {
        return lhs + rhs;
    }else if(op === "-") {
        return lhs - rhs;
    }else if(op === "×") {
        return lhs * rhs;
    }else if(op === "÷") {
        return lhs / rhs;
    }else if(op === "^") {
        return lhs ** rhs;
    }else{
        throw new Error("bad calculation")
    }
}
function calculate(state: CalcState): boolean {
    const lhs = state.previous?.number ?? state.current;
    const rhs = state.previous ? state.current : state.before_eq?.number;
    const op = state.previous ? state.previous.operation : state.before_eq?.operation;
    if(rhs == null || op == null) return false;

    state.before_eq = {
        operation: op,
        lhs,
        number: rhs,
    };
    state.previous = undefined;
    state.current = "" + calculateValue(lhs, op, rhs);

    return true;
}

nr.globalCommand(
	"/help/fun/ultimatetictactoe",
	"ultimatetictactoe",
	{
		usage: "ultimatetictactoe",
		description:
			"Play a game of ultimate tic tac toe.",
		extendedDescription: `Instructions:
For better instructions, read {Link|https://mathwithbaddrawings.com/2013/06/16/ultimate-tic-tac-toe/}
- On your turn, select which board to play on (if you have a choice) and then play your x/o.
- When you get 3 in a row on a small board, you win that board.
- To win the game, get 3 small boards in a row (up/down, left/right, or diagonal)
- The square you play on determines which square your opponent must play on.

{Screenshot|https://i.imgur.com/m0CGIb5.png}

`,
		examples: [
			{
				in: "ultimate tictactoe",
				out: "{Screenshot|https://i.imgur.com/SsjvYYm.png}",
			},
		],
		perms: {fun: true},
	},
	nr.list(),
	async ([], info) => {
		const api = info.message.client as any as ApiHolder;

		const game_id = await createGame<UTTTState>("UTTT", {
            mode: "joining",
            initiator: info.message.author.id,
        });
        await renderGame(info, game_id);
	},
);
nr.globalAlias("ultimatetictactoe", "ultimate tic tac toe");
nr.globalAlias("ultimatetictactoe", "ultimate tictactoe");
nr.globalAlias("ultimatetictactoe", "uttt");
nr.globalAlias("ultimatetictactoe", "bigtictactoe");
nr.globalAlias("ultimatetictactoe", "big tic tac toe");
nr.globalAlias("ultimatetictactoe", "big tictactoe");
nr.globalAlias("ultimatetictactoe", "ultimate knotsandcrosses");
nr.globalAlias("ultimatetictactoe", "ultimateknotsandcrosses");
nr.globalAlias("ultimatetictactoe", "ultimate knots and crosses");
nr.globalAlias("ultimatetictactoe", "big knotsandcrosses");
nr.globalAlias("ultimatetictactoe", "bigknotsandcrosses");
nr.globalAlias("ultimatetictactoe", "big knots and crosses");


import * as uttt from "../gamelib/ultimatetictactoe";
type UTTTState = {
    mode: "joining";
    initiator: string;
} | {
    mode: "playing";
    state: uttt.UltimateTicTacToe,
} | {mode: "canceled"} | {mode: "unsupported"};

const UTTTGame: Game<UTTTState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.initiator+"> is starting a game of Ultimate Tic Tac Toe",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing") {
            let components: ActionRow[];
            if(uttt.checkGameOver(state.state)) {
                components = [
                    componentRow([
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ];
            }else{
                const moves = uttt.getMoves(state.state);

                const ts = uttt.tileset.tiles;
                const mm: {[key: string]: boolean} = {};
                moves.forEach(move => mm[move.button] = true);
                const is_l2 = state.state.status.s === "playing" ? state.state.status.board === "pick" : false;
                const bstyl = is_l2 ? "primary" : "secondary";
                components = [
                    componentRow([
                        button(key("E,"+ts.buttons[0]), "1", bstyl, {disabled: !mm[ts.buttons[0]]}),
                        button(key("E,"+ts.buttons[1]), "2", bstyl, {disabled: !mm[ts.buttons[1]]}),
                        button(key("E,"+ts.buttons[2]), "3", bstyl, {disabled: !mm[ts.buttons[2]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.buttons[3]), "4", bstyl, {disabled: !mm[ts.buttons[3]]}),
                        button(key("E,"+ts.buttons[4]), "5", bstyl, {disabled: !mm[ts.buttons[4]]}),
                        button(key("E,"+ts.buttons[5]), "6", bstyl, {disabled: !mm[ts.buttons[5]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.buttons[6]), "7", bstyl, {disabled: !mm[ts.buttons[6]]}),
                        button(key("E,"+ts.buttons[7]), "8", bstyl, {disabled: !mm[ts.buttons[7]]}),
                        button(key("E,"+ts.buttons[8]), "9", bstyl, {disabled: !mm[ts.buttons[8]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.backbtn), "⎌", "primary", {disabled: !mm[ts.backbtn]}),
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                        button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                    ]),
                ];
            }
            return {
                content: uttt.render(state.state)[0],
                components,
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled") {
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<UTTTState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as UTTTState;

        console.log(game_state);

        if(ikey.name === PSKeys.playing.rules) {
            if(info.raw_interaction) {
                await info.raw_interaction.replyHiddenHideCommand("" +
                    "- On your turn, select which board to play on (if you have a choice) and then play your x/o.\n" +
                    "- When you get 3 in a row on a small board, you win that board.\n" +
                    "- To win the game, win 3 small boards in a row (up/down, left/right, or diagonal)\n" +
                    "- The square you play on determines which board your opponent must play on next.", [
                        componentRow([{
                            type: 2,
                            style: 5, // URL
                            label: "More Help",
                            url: "https://interpunct.info/help/fun/ultimatetictactoe",
                            disabled: false,
                        }]),
                    ]
                );
            }else{
                await info.accept();
            }
            return {__interaction_handled: true as any};
        }else if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.initiator) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as any};
                }else{
                    return await updateGameState<UTTTState>(info, ikey, {
                        mode: "playing",

                        state: uttt.setup([state.initiator, info.message.author.id]),
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.initiator) {
                    return await updateGameState<UTTTState>(info, ikey, {
                        mode: "canceled",
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.initiator+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(uttt.checkGameOver(state.state)) {
                return await errorGame(info, "The game is over");
            }

            if(ikey.name === BasicKeys.playing.give_up) {
                if(state.state.status.s === "playing" && state.state.players[state.state.status.turn].id === info.message.author.id) {
                    state.state.status = {
                        s: "winner",
                        winner:
                            state.state.players[state.state.status.turn === "x" ? "o" : "x"],
                        reason: "Other player gave up",
                    };
                    return await updateGameState(info, ikey, state);
                }else{
                    return await errorGame(info, "You can't do that.");
                }
            }

            if(ikey.name.startsWith("E,")) {
                const kbtn = ikey.name.replace("E,", "");
                const moves = uttt.getMoves(state.state);
                const move = moves.find(move => move.button === kbtn);
                if(!move) return await errorGame(info, "You can't do that.");
                if(move.player.id !== info.message.author.id) return await errorGame(info, "You can't do that.");
                return await updateGameState(info, ikey, {mode: "playing", state: move.apply(state.state)});
            }

            // if(state.over) return await errorGame(info, "This game is over.");
            // if(info.message.author.id !== state.players[state.player]) {
            //     if(!JSON.stringify(state.player).includes(info.message.author.id)) { // hack
            //         return await errorGame(info, "You're not in this game");
            //     }
            //     return await errorGame(info, "It's not your turn");
            // }
            // if(ikey.name === BasicKeys.playing.give_up) {
            //     // other player wins
            //     state.player += 1;
            //     state.player %= state.players.length;
            //     state.over = {
            //         reason: "Other player gave up",
            //     };
            //     return await updateGameState<PSState>(info, ikey, state);
            // }

            // what we're going to do is call uttt and get a list of supported moves
            //, find the move == the clicked button, activate it if the player id matches
            
            return await errorGame(info, "TODO support "+ikey.name);
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }
    }
};

import * as conn4 from "../gamelib/connect4";
type Conn4State = {
    mode: "joining";
    initiator: string;
} | {
    mode: "playing";
    state: conn4.Connect4,
} | {mode: "canceled"} | {mode: "unsupported"};

const Conn4Game: Game<Conn4State> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.initiator+"> is starting a game of Connect 4",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing") {
            let components: ActionRow[];
            if(conn4.connect4.checkGameOver(state.state)) {
                components = [
                    componentRow([
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ];
            }else{
                const moves = conn4.connect4.getMoves(state.state);

                const ts = conn4.tileset.tiles;
                const mm: {[key: string]: boolean} = {};
                moves.forEach(move => mm[move.button] = true);
                components = [
                    componentRow([
                        button(key("E,"+ts.buttons[0]), "1", "secondary", {disabled: !mm[ts.buttons[0]]}),
                        button(key("E,"+ts.buttons[1]), "2", "secondary", {disabled: !mm[ts.buttons[1]]}),
                        button(key("E,"+ts.buttons[2]), "3", "secondary", {disabled: !mm[ts.buttons[2]]}),
                        button(key("E,"+ts.buttons[3]), "4", "secondary", {disabled: !mm[ts.buttons[3]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.buttons[4]), "5", "secondary", {disabled: !mm[ts.buttons[4]]}),
                        button(key("E,"+ts.buttons[5]), "6", "secondary", {disabled: !mm[ts.buttons[5]]}),
                        button(key("E,"+ts.buttons[6]), "7", "secondary", {disabled: !mm[ts.buttons[6]]}),
                    ]),
                    componentRow([
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                        button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                    ]),
                ];
            }
            return {
                content: conn4.connect4.render(state.state)[0],
                components,
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled") {
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<Conn4State>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as Conn4State;

        console.log(game_state);

        if(ikey.name === PSKeys.playing.rules) {
            if(info.raw_interaction) {
                await info.raw_interaction.replyHiddenHideCommand("" +
                    "Try to get 4 in a row in any direction, including diagonal.", [
                        componentRow([{
                            type: 2,
                            style: 5, // URL
                            label: "More Help",
                            url: "https://interpunct.info/help/fun/ultimatetictactoe",
                            disabled: false,
                        }]),
                    ]
                );
            }else{
                await info.accept();
            }
            return {__interaction_handled: true as any};
        }else if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.initiator) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as any};
                }else{
                    return await updateGameState<Conn4State>(info, ikey, {
                        mode: "playing",

                        state: conn4.connect4.setup([{id: state.initiator}, {id: info.message.author.id}]),
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.initiator) {
                    return await updateGameState<Conn4State>(info, ikey, {
                        mode: "canceled",
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.initiator+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(conn4.connect4.checkGameOver(state.state)) {
                return await errorGame(info, "The game is over");
            }

            if(ikey.name === BasicKeys.playing.give_up) {
                if(state.state.status.s === "playing" && state.state.players[state.state.turn].id === info.message.author.id) {
                    state.state.status = {
                        s: "winner",
                        winner:
                            state.state.players[state.state.turn === "r" ? "y" : "r"],
                        reason: "Other player gave up",
                    };
                    return await updateGameState<Conn4State>(info, ikey, state);
                }else{
                    return await errorGame(info, "You can't do that.");
                }
            }

            if(ikey.name.startsWith("E,")) {
                const kbtn = ikey.name.replace("E,", "");
                const moves = conn4.connect4.getMoves(state.state);
                const move = moves.find(move => move.button === kbtn);
                if(!move) return await errorGame(info, "You can't do that.");
                if(move.player.id !== info.message.author.id) return await errorGame(info, "You can't do that.");
                return await updateGameState<Conn4State>(info, ikey, {mode: "playing", state: move.apply(state.state)});
            }
            
            return await errorGame(info, "TODO support "+ikey.name);
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }
    }
};

nr.globalCommand(
	"/help/fun/connect4",
	"connect4",
	{
		usage: "connect4",
		description:
			"Play a game of connect 4.",
		extendedDescription:
			"To play connect4, select where to drop your tile and try to make a sequence of 4 in any direction including diagonal.",
		examples: [
			{
				in: "connect4",
				out: "{Screenshot|https://i.imgur.com/3YjxBXi.png}",
			},
		],
		perms: {fun: true},
	},
	nr.passthroughArgs,
	async ([], info) => {
		const game_id = await createGame<Conn4State>("C4", {mode: "joining", initiator: info.message.author.id});
        await renderGame(info, game_id);
	},
);
nr.globalAlias("connect4", "connect 4");
nr.globalAlias("connect4", "conn4");



import * as chec from "../gamelib/checkers";
type CheckersState = {
    mode: "joining";
    initiator: string;
} | {
    mode: "playing";
    state: chec.Checkers,
} | {mode: "canceled"} | {mode: "unsupported"};

const CheckersGame: Game<CheckersState> = {
    render(state, game_id, game_kind, game_stage, info): SampleMessage {
        const key = (name: string) => getInteractionKey(game_id, game_kind, game_stage, name);

        if(state.mode === "joining") {
            return {
                content: "<@"+state.initiator+"> is starting a game of Checkers",
                components: [
                    componentRow([
                        button(key(BasicKeys.joining.join), "Join Game", "accept", {}),
                        button(key(BasicKeys.joining.end), "Cancel", "deny", {}),
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ],
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "playing") {
            let components: ActionRow[];
            if(chec.checkers.checkGameOver(state.state)) {
                components = [
                    componentRow([
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                ];
            }else{
                const moves = chec.checkers.getMoves(state.state);

                const ts = chec.tileset.tiles.interaction;
                const mm: {[key: string]: boolean} = {};
                moves.forEach(move => mm[move.button] = true);
                components = [
                    componentRow([
                        button(key("E,"+ts.arrows.ul), "↖", "secondary", {disabled: !mm[ts.arrows.ul]}),
                        button(key("E,"+ts.arrows.ur), "↗", "secondary", {disabled: !mm[ts.arrows.ur]}),
                        button(key(PSKeys.playing.rules), "Rules", "secondary", {emoji: {name: "rules", id: "476514294075490306", animated: false}}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.arrows.dl), "↙", "secondary", {disabled: !mm[ts.arrows.dl]}),
                        button(key("E,"+ts.arrows.dr), "↘", "secondary", {disabled: !mm[ts.arrows.dr]}),
                        button(key(BasicKeys.playing.give_up), "Give Up", "deny", {}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.pieces[0]), "1", "secondary", {disabled: !mm[ts.pieces[0]]}),
                        button(key("E,"+ts.pieces[1]), "2", "secondary", {disabled: !mm[ts.pieces[1]]}),
                        button(key("E,"+ts.pieces[2]), "3", "secondary", {disabled: !mm[ts.pieces[2]]}),
                        button(key("E,"+ts.pieces[3]), "4", "secondary", {disabled: !mm[ts.pieces[3]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.pieces[4]), "5", "secondary", {disabled: !mm[ts.pieces[4]]}),
                        button(key("E,"+ts.pieces[5]), "6", "secondary", {disabled: !mm[ts.pieces[5]]}),
                        button(key("E,"+ts.pieces[6]), "7", "secondary", {disabled: !mm[ts.pieces[6]]}),
                        button(key("E,"+ts.pieces[7]), "8", "secondary", {disabled: !mm[ts.pieces[7]]}),
                    ]),
                    componentRow([
                        button(key("E,"+ts.pieces[8]), "9", "secondary", {disabled: !mm[ts.pieces[8]]}),
                        button(key("E,"+ts.pieces[9]), "A", "secondary", {disabled: !mm[ts.pieces[9]]}),
                        button(key("E,"+ts.pieces[10]), "B", "secondary", {disabled: !mm[ts.pieces[10]]}),
                        button(key("E,"+ts.pieces[11]), "C", "secondary", {disabled: !mm[ts.pieces[11]]}),
                    ]),
                ];
            }
            return {
                content: chec.checkers.render(state.state)[0],
                components,
                allowed_mentions: {parse: []},
            };
        }else if(state.mode === "canceled") {
            return {
                content: "Canceled game.",
                components: [],
                allowed_mentions: {parse: []},
            };
        }else{
            return {
                content: "Unsupported "+state.mode,
                components: [],
                allowed_mentions: {parse: []},
            };
        }
    },
    async handleInteraction(info, custom_id): Promise<InteractionHandled<CheckersState>> {
        const ikey = parseInteractionKey(custom_id);
        const game_state = await getGameData(ikey.game_id);
        const key = (name: string) => getInteractionKey(ikey.game_id, ikey.kind, ikey.stage, name);

        if(game_state.stage != ikey.stage) {
            return await errorGame(info, "This button is no longer active.");
        }
        const state = game_state.state as CheckersState;

        console.log(game_state);

        if(ikey.name === PSKeys.playing.rules) {
            if(info.raw_interaction) {
                await info.raw_interaction.replyHiddenHideCommand("" +
                    "Try to capture all your opponent's pieces.", [
                        componentRow([{
                            type: 2,
                            style: 5, // URL
                            label: "More Help",
                            url: "http://www.darkfish.com/checkers/rules.html",
                            disabled: false,
                        }]),
                    ]
                );
            }else{
                await info.accept();
            }
            return {__interaction_handled: true as any};
        }else if(state.mode === "joining") {
            if(ikey.name === BasicKeys.joining.join || ikey.name === BasicKeys.joining.join_anyway) {
                if(ikey.name !== BasicKeys.joining.join_anyway && info.message.author.id === state.initiator) {
                    if(info.raw_interaction) {
                        await info.raw_interaction.replyHiddenHideCommand("You are already in the game.", [
                            componentRow([
                                button(key(BasicKeys.joining.join_anyway), "Play against yourself", "secondary", {}),
                            ]),
                        ]);
                    }else{
                        await info.accept();
                    }
                    return {__interaction_handled: true as any};
                }else{
                    return await updateGameState<CheckersState>(info, ikey, {
                        mode: "playing",

                        state: chec.checkers.setup([{id: state.initiator}, {id: info.message.author.id}]),
                    });
                }
            }else if(ikey.name === BasicKeys.joining.end) {
                if(info.message.author.id === state.initiator) {
                    return await updateGameState<CheckersState>(info, ikey, {
                        mode: "canceled",
                    });
                }else{
                    return await errorGame(info, "Only <@"+state.initiator+"> can cancel.");
                }
            }else{
                return await errorGame(info, "Error! Unsupported "+ikey.name);
            }
        }else if(state.mode === "playing") {
            if(chec.checkers.checkGameOver(state.state)) {
                return await errorGame(info, "The game is over");
            }

            if(ikey.name === BasicKeys.playing.give_up) {
				if (state.state.status.s === "winner" || state.state.status.s === "tie") {
                    return await errorGame(info, "The game is over.");
                }
                if(state.state.players[state.state.status.turn].id !== info.message.author.id) {
                    return await errorGame(info, "You can't do that.");
                }
				const nextplayer = state.state.players[state.state.status.turn === "red" ? "black" : "red"];
				state.state.status = {
					s: "winner",
					reason: "Time out.",
					winner: nextplayer,
				};
				chec.updateOverlay(state.state);

				return await updateGameState(info, ikey, state);
            }

            if(ikey.name.startsWith("E,")) {
                const kbtn = ikey.name.replace("E,", "");
                const moves = chec.checkers.getMoves(state.state);
                const move = moves.find(move => move.button === kbtn);
                if(!move) return await errorGame(info, "You can't do that.");
                if(move.player.id !== info.message.author.id) return await errorGame(info, "You can't do that.");
                return await updateGameState<CheckersState>(info, ikey, {mode: "playing", state: move.apply(state.state)});
            }
            
            return await errorGame(info, "TODO support "+ikey.name);
        }else if(state.mode === "canceled") {
            return await errorGame(info, "This game was not started.");
        }else{
            return await errorGame(info, "TODO support "+state.mode);
        }
    }
};
nr.globalCommand(
	"/help/fun/checkers",
	"checkers",
	{
		usage: "checkers",
		description:
			"Play a game of checkers.",
		extendedDescription:
			"To play checkers, try to take all your opponents' pieces. For more help, look up the rules online. {Link|http://www.darkfish.com/checkers/rules.html}",
		examples: [
			{
				in: "checkers",
				out: "{Screenshot|https://i.imgur.com/Nx3tVMB.png}",
			},
		],
		perms: {fun: true},
	},
	nr.passthroughArgs,
	async ([], info) => {
		const game_id = await createGame<CheckersState>("CHK", {mode: "joining", initiator: info.message.author.id});
        await renderGame(info, game_id);
	},
);

type GameKind =
    | "TTT" // tic tac toe
    | "CG" // circlegame
    | "PS" // paper soccer
    | "CALC" // calculator
    | "UTTT" // ultimate tic tac toe
    | "C4" // connect 4
    | "CHK" // checkers
;

const games: {[key in GameKind]: Game<any>} = {
    "TTT": TTTGame,
    "CG": CGGame,
    "PS": PSGame,
    "CALC": Calculator,
    "UTTT": UTTTGame,
    "C4": Conn4Game,
    "CHK": CheckersGame,
};