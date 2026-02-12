import { Bot } from 'grammy';

const bot = new Bot('8440919102:AAF-l6DIR-SZAvE1sroyvAlNRSRXDJ0g76M');

bot.command('start', (ctx) => ctx.reply('Hello!'));

console.log('Starting bot...');
bot.start({
  onStart: () => console.log('✅ Bot started successfully!'),
});
