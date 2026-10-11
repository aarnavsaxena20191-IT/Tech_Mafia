require('dotenv').config();
const http=require('http');const path=require('path');const crypto=require('crypto');const express=require('express');const helmet=require('helmet');const compression=require('compression');const cookieParser=require('cookie-parser');const cors=require('cors');const rateLimit=require('express-rate-limit');const {models,connectDatabase,mongoose}=require('./db');const {authenticate}=require('./middleware/auth');const {notFound,errorHandler}=require('./middleware/errors');const {createRealtime,emitMatch}=require('./realtime');const matches=require('./services/matches');
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32||process.env.JWT_SECRET.toLowerCase().startsWith('replace-with-')){console.error('JWT_SECRET must be configured as a unique secret with at least 32 characters. Copy .env.example to .env and replace the placeholder.');process.exit(1)}
const app=express();const server=http.createServer(app);const io=createRealtime(server);app.locals.io=io;app.disable('x-powered-by');app.set('trust proxy',process.env.TRUST_PROXY==='true'||process.env.RENDER==='true'?1:false);app.use((req,res,next)=>{req.id=crypto.randomUUID();res.setHeader('X-Request-ID',req.id);next()});app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://cdn.socket.io','https://cdnjs.cloudflare.com'],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com','data:'],connectSrc:["'self'",process.env.CLIENT_ORIGIN||"'self'",'ws:','wss:'],imgSrc:["'self'",'data:'],objectSrc:["'none'"],frameAncestors:["'none'"]}}}));app.use(compression());app.use(cors({origin:process.env.CLIENT_ORIGIN||false,credentials:true}));app.use(express.json({limit:'128kb'}));app.use(cookieParser());const anonymousApiLimit=rateLimit({windowMs:60_000,limit:1200,standardHeaders:'draft-7',legacyHeaders:false});const authenticatedApiLimit=rateLimit({windowMs:60_000,limit:300,standardHeaders:'draft-7',legacyHeaders:false,keyGenerator:req=>req.user.id});app.use('/api',anonymousApiLimit);
app.get('/health',(_req,res)=>{const connected=mongoose.connection.readyState===1;res.status(connected?200:503).json({status:connected?'ok':'degraded',database:connected?'connected':'unavailable',timestamp:new Date().toISOString()})});
const authRoutes=require('./routes/auth');const loginAttemptLimit=rateLimit({windowMs:15*60_000,limit:10,skipSuccessfulRequests:true,standardHeaders:'draft-7',legacyHeaders:false,keyGenerator:req=>crypto.createHash('sha256').update(String(req.body?.email||'').trim().toLowerCase()).digest('hex')});app.use('/api/auth',loginAttemptLimit,authRoutes.publicRouter);app.use('/api/auth',authenticate,authenticatedApiLimit,authRoutes.protectedRouter);app.use('/api/registration',require('./routes/registration'));
app.use('/api/matches',authenticate,authenticatedApiLimit,require('./routes/matches')(io));app.use('/api/tournament',authenticate,authenticatedApiLimit,require('./routes/tournament'));app.use('/api/problems',authenticate,authenticatedApiLimit,require('./routes/problems'));app.use('/api/progress',authenticate,authenticatedApiLimit,require('./routes/progress'));app.use('/api/final',authenticate,authenticatedApiLimit,require('./routes/final'));
if(process.env.NODE_ENV!=='production')app.use('/api/dev',authenticate,async(req,res,next)=>{try{if(req.user.role!=='admin')return res.status(403).json({error:{message:'Forbidden'}});const users=await models.User.find().sort({createdAt:1}).limit(100).select('_id email display_name role').lean();res.json({users})}catch(e){next(e)}});
const webRoot=path.join(__dirname,'..');app.get(['/','/index.html'],(_req,res)=>{res.setHeader('Cache-Control','no-cache');res.sendFile(path.join(webRoot,'index.html'))});app.get('/script.js',(_req,res)=>res.sendFile(path.join(webRoot,'script.js')));app.get('/style.css',(_req,res)=>res.sendFile(path.join(webRoot,'style.css')));app.use('/api',(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'API endpoint not found.'}}));app.use(notFound);app.use(errorHandler);
let timerBusy=false;
async function tickMatches(){
  if(timerBusy)return;
  timerBusy=true;
  try{
    const now=new Date();
    const [expiredMatches,finals]=await Promise.all([
      models.Match.find({state:'ACTIVE',ends_at:{$ne:null,$lte:now}}).select('_id').limit(100).lean(),
      models.FinalCompetition.find({state:'ACTIVE',ends_at:{$ne:null,$lte:now}}),
    ]);
    for(const match of expiredMatches){
      const result=await matches.expireMatch({id:match._id});
      if(result)emitMatch(io,match._id,'match:completed',{matchId:match._id,winnerTeamId:result.winner_team_id,reason:'timeout'});
    }
    for(const final of finals){
      final.state='COMPLETED';
      const ranked=final.entries.slice().sort((a,b)=>b.score-a.score||b.passed_tests-a.passed_tests||(a.completion_ms??Infinity)-(b.completion_ms??Infinity)||b.debugging_score-a.debugging_score||b.defense_score-a.defense_score);
      ranked.forEach((entry,index)=>{const found=final.entries.find(item=>item.team_id===entry.team_id);found.rank=index+1});
      await final.save();
      io.emit('tournament:final:completed',{competitionId:final._id});
    }
  }catch(error){console.error('Match timer tick failed:',error.message)}
  finally{timerBusy=false}
}
const timer=setInterval(tickMatches,1000);timer.unref();const port=Number(process.env.PORT||3000);
async function shutdown(signal){console.log(`${signal}: shutting down`);clearInterval(timer);server.close(async()=>{await mongoose.disconnect();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()};process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
connectDatabase().then(()=>server.listen(port,()=>console.log(`Find the Hacker listening on http://localhost:${port}`))).catch(error=>{console.error('MongoDB connection failed:',error.message);process.exit(1)});
module.exports={app,server,io};
