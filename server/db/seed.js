require('dotenv').config();
const bcrypt = require('bcryptjs');
const { models, connectDatabase, mongoose, transaction } = require('./index');

async function seed() {
  try {
    await connectDatabase();
    await transaction(async (session) => {
      const tournament = await models.Tournament.findOneAndUpdate(
        { name: process.env.TOURNAMENT_NAME || 'ICI Techfest 2025' },
        {
          $setOnInsert: { status: 'active' },
          $set: {
            'config.matchDurationSeconds': Number(process.env.MATCH_DURATION_SECONDS || 900),
            'config.attacksPerDetective': Number(process.env.ATTACKS_PER_DETECTIVE || 3),
            'config.registrationOpen': process.env.REGISTRATION_OPEN !== 'false',
          },
        },
        { upsert: true, returnDocument: 'after', session },
      );
      const adminHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'ChangeThisAdminPassword!', 12);
      await models.User.updateOne(
        { email: (process.env.SEED_ADMIN_EMAIL || 'admin@findhacker.local').toLowerCase() },
        { $setOnInsert: { password_hash: adminHash, display_name: 'Event Administrator', role: 'admin', is_active: true } },
        { upsert: true, session },
      );
      await models.Round.findOneAndUpdate(
        { tournament_id: tournament._id, round_number: 1 },
        { $setOnInsert: { name: 'Qualifiers', kind: 'bracket', status: 'active' } },
        { upsert: true, session },
      );
    });
    console.log('Tournament and organizer account are ready. No sample teams, participant accounts, matches, or challenges were created.');
    console.log(`Organizer: ${process.env.SEED_ADMIN_EMAIL || 'admin@findhacker.local'} / ${process.env.SEED_ADMIN_PASSWORD || 'ChangeThisAdminPassword!'}`);
    console.log('Teams register three to five participant accounts on the website. Each pair is automatically assigned coder and detective roles.');
  } catch (error) {
    console.error('MongoDB seed failed:', error.stack || error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seed();
