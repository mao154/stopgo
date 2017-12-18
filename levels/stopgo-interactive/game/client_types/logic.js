/**
 * # Logic type implementation of the game stages
 * Copyright(c) 2017 Stefano Balietti <ste@nodegame.org>
 * MIT Licensed
 *
 * http://www.nodegame.org
 * ---
 */

"use strict";

var fs = require('fs');
var path = require('path');
var ngc = require('nodegame-client');

module.exports = function(treatmentName, settings, stager, setup, gameRoom) {

    var node = gameRoom.node;
    var channel = gameRoom.channel;

    // Must implement the stages here.

    stager.setOnInit(function() {
        // Initialize the client.
        // channel.numChooseStop = 0;
        // channel.numStopGoDecisions = 0;
        // channel.numChooseRight = 0;
        // channel.numRightLeftDecisions = 0;

        readBotData('avgDecisions.csv');

        
        // Add session name to data in DB.
        this.memory.on('insert', function(o) {
            o.room = node.nodename;
            o.treatment = treatmentName;
            o.bot = !!channel.bots[o.player];
        });
        
        node.game.choices = {};
        node.game.tables = {};
        node.game.totals = {};
        node.game.history = {};

        node.on.pdisconnect(function(player) {
            var role, options;
            player.allowReconnect = false; // check if registry maybe
            if (node.game.pl.first().clientType !== "bot") {

                role = node.game.matcher.getRoleFor(player.id);

                options = {
                    room: gameRoom,
                    // id: player.id, Otherwise it gets the wrong clinetType
                    clientType: 'bot',
                    setup: {
                        settings: {
                            botType: 'dynamic',
                            // 'dynamic' for based on player results
                            chanceOfStop: 0.5,
                            chanceOfRight: 0.5
                        }
                    },
                    // BUG: error when RED disconnects
                    // TODO: if replaceId is set should options from old data.
                    replaceId: player.id,
                    gotoStep: node.player.stage,
                    ready: function(bot) {
                        node.game.tables[bot.player.id] =
                            node.game.tables[player.id];

                        // Save the Red choice, if it was done already.
                        if (node.game.choices[player.id]) {
                            node.game.choices[bot.player.id] =
                                node.game.choices[player.id];
                        }   
                    }
                };

                // TODO: improve.
                if (node.player.stage.step !== 3) {
                    options.gotoStepOptions = {
                        plot: { 
                            partner: node.game.matcher.getMatchFor(player.id),
                            role: node.game.matcher.getRoleFor(player.id)
                        }
                    };
                }

                channel.connectBot(options);
                
            }

        });
    });

    stager.extendStep('red-choice', {
        matcher: {
            roles: [ 'RED', 'BLUE' ],
            fixedRoles: true,
            canMatchSameRole: false,
            match: 'roundrobin',
            cycle: 'repeat'//,
            // skipBye: false,
            // sayPartner: false
        },
        cb: function() {
            var allMatchesInRound;
            var i;
            var match;
            var roles;
            var payoffTable;

            allMatchesInRound = node.game.matcher.getMatches('ARRAY_ROLES_ID');

            for (i = 0; i < allMatchesInRound.length; i++) {
                roles = allMatchesInRound[i];
                payoffTable = getRandomTable();
                node.game.tables[roles.RED] = payoffTable;
                node.say('TABLE', roles.RED, payoffTable);
            }

            node.on.data('done', function(msg) {
                var id, otherId;
                var playerObj;
                var role;
                var redChoice;

                id = msg.from;
                role = node.game.matcher.getRoleFor(id);
                otherId = node.game.matcher.getMatchFor(id);
                // Add info to data, so that it is saved in database.
                msg.data.partner = otherId;
 
                if (role === 'RED') {
                    playerObj = node.game.pl.get(id);
                    redChoice = msg.data.redChoice;
                    node.game.choices[id] = { redChoice: redChoice };

                    if (playerObj.clientType !== 'bot') {
                        if (redChoice === 'STOP') {
                            channel.numChooseStop += 1;
                        }
                        channel.numStopGoDecisions += 1;
                    }

                    // validate selection
                    // TODO: move validation to before node.game.redChoice
                    // is assigned.
                    if (msg.data.redChoice) {
                        node.say('RED-CHOICE', otherId, redChoice);
                    }
                    else {
                        node.err('Invalid Red choice. ID of sender: ' + id);
                    }
                }
            });
        }
    });

    stager.extendStep('blue-choice', {
        cb: function() {
            node.on.data('done', function(msg) {
                var id, otherId;
                var blueChoice;
                var playerObj;
                var role;
                var choices;

                id = msg.from;
                role = node.game.matcher.getRoleFor(id);

                if (role === 'BLUE') {
                    otherId = node.game.matcher.getMatchFor(id);
                    choices = node.game.choices;
                    blueChoice = msg.data.blueChoice;
                    choices[otherId].blueChoice = blueChoice;

                    playerObj = node.game.pl.get(id);

                    if (playerObj.clientType !== 'bot') {
                        if (choices[otherId].blueChoice === 'RIGHT') {
                            channel.numChooseRight += 1;
                        }
                        channel.numRightLeftDecisions += 1;
                        // console.log('RIGHT/LEFT: ' + channel.numChooseRight
                        // / channel.numRightLeftDecisions);
                    }

                    // TODO: move validation to before
                    // node.game.choices[roles.RED].blueChoice is assigned
                    if (msg.data.blueChoice) {
                        node.say('BLUE-CHOICE', otherId, blueChoice);
                    }
                    else {
                        node.err('Invalid Blue choice. ID of sender: ' + id);
                    }
                }
            });
        }
    });

    stager.extendStep('results', {
        cb: function() {
            var payoffs, results;
            var allMatchesInRound;
            var match;
            var roles;
            var i;

            allMatchesInRound = node.game.matcher.getMatches('ARRAY_ROLES_ID');

            for (i = 0; i < allMatchesInRound.length; i++) {

                roles = allMatchesInRound[i];

                console.log('ROLES');
                console.log(roles);

                payoffs = calculatePayoffs(node.game.choices[roles.RED],
                                           node.game.tables[roles.RED]);

                if (!node.game.totals[roles.RED]) {
                    node.game.totals[roles.RED] = 0;
                }
                node.game.totals[roles.RED] += payoffs.RED;;

                if (!node.game.totals[roles.BLUE]) {
                    node.game.totals[roles.BLUE] = 0;
                }
                node.game.totals[roles.BLUE] += payoffs.BLUE;;

                addData(roles.RED, payoffs.RED);
                addData(roles.BLUE, payoffs.BLUE);

                results = {
                    payoffs: payoffs,

                    choices: {
                        RED: node.game.choices[roles.RED].redChoice,
                        BLUE: node.game.choices[roles.RED].blueChoice
                    },

                    world: node.game.tables[roles.RED]
                };

                addToHistory(roles.RED, results, node.game.history);
                addToHistory(roles.BLUE, results, node.game.history);

                node.say('RESULTS', roles.RED, results);
                node.say('RESULTS', roles.BLUE, results);
            }
        }
    });

    stager.extendStep('end', {
        cb: function() {
            var code;
            var allMatchesInRound;
            var roles;
            var i;

            allMatchesInRound = node.game.matcher.getMatches('ARRAY_ROLES_ID');

            // allMatchesInRound = node.game.matcher.getMatches();

            for (i = 0; i < allMatchesInRound.length; i++) {
                roles = allMatchesInRound[i];
                code = channel.registry.getClient(roles.RED);

                node.say('WIN', roles.RED, {
                    totalRaw: node.game.totals[roles.RED],
                    exit: code.ExitCode
                });

                code = channel.registry.getClient(roles.BLUE);

                node.say('WIN', roles.BLUE, {
                    totalRaw: node.game.totals[roles.BLUE],
                    exit: code.ExitCode
                });
            }

            node.on.data('email', function(msg) {
                var id, code;
                id = msg.from;

                code = channel.registry.getClient(id);
                if (!code) {
                    console.log('ERROR: no codewen in endgame:', id);
                    return;
                }

                // Write email.
                appendToCSVFile(msg.data, code, 'email');
            });

            node.on.data('feedback', function(msg) {
                var id, code;
                id = msg.from;

                code = channel.registry.getClient(id);
                if (!code) {
                    console.log('ERROR: no codewen in endgame:', id);
                    return;
                }

                // Write email.
                appendToCSVFile(msg.data, code, 'feedback');
            });

            // Save db and avgDecisions.
            saveAll();
        }
    });

    function appendToCSVFile(email, code, fileName) {
        var row;

        row  = '"' + (code.id || code.AccessCode || 'NA') + '", "' +
            (code.workerId || 'NA') + '", "' + email + '"\n';

        fs.appendFile(gameRoom.dataDir + fileName + '.csv', row, function(err) {
            if (err) {
                console.log(err);
                console.log(row);
            }
        });
    }

    function addToHistory(id, results, history) {
        if (!history[id]) {
            history[id] = [];
        }
        history[id].push(results);
    }

    function addData(playerId, data) {
        if (node.game.memory.player[playerId]){
            var item = node.game.memory.player[playerId].last();
            item.bonus = data;
        }
    }

    // returns payoffs as a object
    function calculatePayoffs(choices, table) {
        var payoffs, bluePayoff, redPayoff;
        var blueChoice;

        payoffs = settings.payoffs;
        blueChoice = choices.blueChoice;

        if (choices.redChoice === 'GO') {
            console.log('CHOICES');
            console.log(choices);
            console.log('PAYOFFS.GO');
            console.log(payoffs.GO);
            bluePayoff = payoffs.GO[table][blueChoice].BLUE;
            redPayoff = payoffs.GO[table][blueChoice].RED;
        }
        else {
            bluePayoff = payoffs.STOP.BLUE;
            redPayoff = payoffs.STOP.RED;
        }

        return {
            RED: redPayoff,
            BLUE: bluePayoff
        }
    }

    function getRandomTable() {
        var payoffTable;
        if (Math.random() < node.game.settings.PI) payoffTable = 'A';
        else payoffTable = 'B';        
        return payoffTable;
        // console.log('THE STATE OF THE WORLD IS: ' + node.game.payoffTable);
    }

    function saveAll() {
        var gameDir, line, avgDecisionFilePath;
        gameDir = channel.getGameDir();
        node.game.memory.save('db.json');
        node.game.memory.save('db.csv', {
            bool2num: true,
            headers: [
                "room", "treatment",
                "time", "timeup", "timestamp", "player", "bot", 
                "stage.stage", "stage.step","stage.round",
                "redChoice", "blueChoice", "bonus", "partner"
            ]
        });

        avgDecisionFilePath = path.resolve(gameDir, 'data', 'avgDecisions.csv');

        if (!fs.existsSync(avgDecisionFilePath)) {
            fs.appendFile(avgDecisionFilePath,
                          'Node,StopGo,Stop,RightLeft,Right\n');
        }

        line = node.nodename + ',' + channel.numStopGoDecisions +
            ',' + channel.numChooseStop +
            ',' + channel.numRightLeftDecisions +
            ',' + channel.numChooseRight + '\n';

        fs.appendFile(avgDecisionFilePath, line, function(err) {
            if (err) console.log('An error occurred saving: ' + line);
        });
    }

    // should be moved out of logic init so only called once
    function readBotData(fileName) {
        var filePath;
        var db;
        var lastLine;
        var decisions;

        filePath = path.resolve(channel.getGameDir(), 'data', fileName);
        if (fs.existsSync(filePath)) {
            db = new ngc.NDDB();
            db.loadSync(filePath);
            lastLine = db.last();
            console.log(lastLine);
            decisions = lastLine;
            setDecisionsProbabilities(decisions.StopGo,
                                      decisions.Stop,
                                      decisions.RightLeft,
                                      decisions.Right);
        }
        else {
            setDecisionsProbabilities(0, 0, 0, 0);
        }
    }

    function setDecisionsProbabilities(totalStopGo,
                                       totalStop,
                                       totalRightLeft,
                                       totalRight) {

        channel.numStopGoDecisions = totalStopGo;
        channel.numChooseStop = totalStop;
        channel.numRightLeftDecisions = totalRightLeft;
        channel.numChooseRight = totalRight;
    }
}
