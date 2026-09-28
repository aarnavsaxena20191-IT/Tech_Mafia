require('dotenv').config();const {models,connectDatabase,mongoose}=require('./index');
(async()=>{try{await connectDatabase();await Promise.all(Object.values(models).map(model=>model.syncIndexes()));console.log('MongoDB indexes are ready.')}catch(e){console.error('MongoDB index setup failed:',e.message);process.exitCode=1}finally{await mongoose.disconnect()}})();
