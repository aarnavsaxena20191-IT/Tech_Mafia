const mongoose=require('mongoose');
const {models}=require('./models');
async function connectDatabase(){await mongoose.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017/findhacker?replicaSet=rs0',{serverSelectionTimeoutMS:10000});console.log(`MongoDB connected: ${mongoose.connection.name}`)}
async function transaction(fn){const session=await mongoose.startSession();let value;try{await session.withTransaction(async()=>{value=await fn(session)});return value}finally{await session.endSession()}}
module.exports={mongoose,models,connectDatabase,transaction};
