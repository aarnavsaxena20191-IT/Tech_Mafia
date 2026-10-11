const {AppError}=require('../errors');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const judge0LanguageIds={c:Number(process.env.JUDGE0_C_LANGUAGE_ID||50),cpp:Number(process.env.JUDGE0_CPP_LANGUAGE_ID||54)};

function bounded(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}
function isTransientJudgeStatus(status){return status===408||status===425||status===429||status>=500}
function retryDelay(response,fallback){const value=response.headers?.get?.('retry-after');if(value){const seconds=Number(value);const date=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-Date.now();if(Number.isFinite(date)&&date>0)return Math.min(date,5000)}return fallback}
function judgeLookupError(status,body=''){let detail='';try{const parsed=JSON.parse(body);detail=String(parsed.error||parsed.message||'')}catch{detail=String(body||'')}detail=detail.replace(/\s+/g,' ').trim().slice(0,180);if(status===401||status===403)return new AppError(502,`Judge result lookup was rejected (HTTP ${status}). Verify the Judge0 credentials and host in the Render environment.`,'RUNNER_ERROR');if(status===404)return new AppError(502,`Judge result lookup failed (HTTP 404). Verify JUDGE0_URL is the API base URL and that the same host handles submission and polling.${detail?` Judge response: ${detail}`:''}`,'RUNNER_ERROR');if(status===400)return new AppError(502,`Judge rejected its result lookup (HTTP 400). Check JUDGE0_URL and the provider response${detail?`: ${detail}`:'.'}`,'RUNNER_ERROR');return new AppError(502,`Judge result lookup failed (HTTP ${status})${detail?`: ${detail}`:'.'}`,'RUNNER_ERROR')}
function judgeApiBase(value){let url;try{url=new URL(value)}catch{throw new AppError(503,'JUDGE0_URL must be a valid Judge0 API base URL.','RUNNER_UNAVAILABLE')}if(!['http:','https:'].includes(url.protocol))throw new AppError(503,'JUDGE0_URL must use HTTP or HTTPS.','RUNNER_UNAVAILABLE');url.search='';url.hash='';url.pathname=url.pathname.replace(/\/+$/,'').replace(/\/submissions$/,'');return url.toString().replace(/\/$/,'')}
function encodeJudgeText(value){return Buffer.from(String(value??''),'utf8').toString('base64')}
function decodeJudgeText(value){if(typeof value!=='string'||!value)return value||'';return Buffer.from(value,'base64').toString('utf8')}
function decodeJudgeResult(result){for(const field of ['stdout','stderr','compile_output','message'])if(typeof result[field]==='string')result[field]=decodeJudgeText(result[field]);return result}
function normalizeJudge0(result,base64Encoded=false){
 if(base64Encoded)result=decodeJudgeResult(result);
 const status=result.status?.description||'Unknown';
 if(!Number.isInteger(result.status?.id)||result.status.id<3)throw new AppError(502,`Judge returned an incomplete result (${status}).`,'RUNNER_ERROR');
 const stderr=[result.compile_output,result.stderr,result.message].filter(Boolean).join('\n').trim();
 return {exitCode:status==='Accepted'?0:1,stdout:result.stdout||'',stderr,executionMs:Math.round(Number(result.time||0)*1000),status,memoryKb:result.memory??null};
}

async function judge0Execute({language,sourceCode,input,limits={},baseUrl,headers={}}){
 const languageId=judge0LanguageIds[language];
 if(!languageId)throw new AppError(400,'Only C and C++ submissions are supported.','UNSUPPORTED_LANGUAGE');
 const timeoutMs=bounded(process.env.CODE_TIMEOUT_MS,1000,20000,5000);
 const totalWaitMs=bounded(process.env.JUDGE0_REQUEST_TIMEOUT_MS,timeoutMs+5000,90000,45000);
 const cpuSeconds=Math.min(bounded(limits.timeMs,100,15000,timeoutMs),timeoutMs)/1000;
 const memoryKb=bounded(limits.memoryMb,16,256,128)*1024;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),totalWaitMs);
 try{
  const base=judgeApiBase(baseUrl);
  const response=await fetch(`${base}/submissions?base64_encoded=true&wait=false`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({language_id:languageId,source_code:encodeJudgeText(sourceCode),stdin:encodeJudgeText(input),cpu_time_limit:cpuSeconds,cpu_extra_time:1,wall_time_limit:Math.min(cpuSeconds+3,20),memory_limit:memoryKb,stack_limit:Math.min(memoryKb,65536),max_processes_and_or_threads:20,enable_network:false}),signal:controller.signal});
  if(!response.ok){const status=response.status;throw new AppError(status===429||status===503?503:502,`Judge service refused the submission (HTTP ${status}). Verify judge availability and credentials.`,'RUNNER_ERROR')}
  const created=await response.json();
  if(Number.isInteger(created.status?.id)&&created.status.id>=3)return normalizeJudge0(created,true);
  if(!created.token)throw new AppError(502,'Judge did not return a submission token.','RUNNER_ERROR');
  const pollEvery=bounded(process.env.JUDGE0_POLL_INTERVAL_MS,200,2000,400);
  const deadline=Date.now()+totalWaitMs-1000;
  let nextPollDelay=pollEvery;let lastPollFailure=null;
  while(Date.now()<deadline){
   await sleep(Math.min(nextPollDelay,Math.max(50,deadline-Date.now())));
   try{
    const polled=await fetch(`${base}/submissions/${encodeURIComponent(created.token)}?base64_encoded=true`,{headers,signal:controller.signal});
    if(!polled.ok){if(isTransientJudgeStatus(polled.status)){lastPollFailure=`HTTP ${polled.status}`;nextPollDelay=retryDelay(polled,Math.min(2000,nextPollDelay*2));continue}const errorBody=await polled.text().catch(()=> '');throw judgeLookupError(polled.status,errorBody)}
    const result=await polled.json();
    if(Number.isInteger(result.status?.id)&&result.status.id>=3)return normalizeJudge0(result,true);
    if(!Number.isInteger(result.status?.id))throw new AppError(502,'Judge returned an invalid result status. Check the configured Judge0 endpoint.','RUNNER_ERROR');
    nextPollDelay=pollEvery;
   }catch(error){if(error.name==='AbortError')throw error;if(error instanceof AppError)throw error;lastPollFailure='a temporary network error';nextPollDelay=Math.min(2000,nextPollDelay*2)}
  }
  if(lastPollFailure)throw new AppError(503,`Judge did not return a result before the service timeout (${lastPollFailure}). The test was not graded; retry when the judge is available.`,'RUNNER_UNAVAILABLE');
  throw new AppError(504,'Execution took too long. Try again or simplify the program.','EXECUTION_TIMEOUT');
 }catch(error){if(error.name==='AbortError')throw new AppError(504,'Execution timed out. The judge did not respond in time.','EXECUTION_TIMEOUT');if(error instanceof AppError)throw error;throw new AppError(502,'Could not connect to the isolated code judge. Check the judge URL and service status.','RUNNER_ERROR')}finally{clearTimeout(timer)}
}

async function execute({language,sourceCode,input,limits={}}){
 let mode=process.env.EXECUTION_MODE||'disabled';
 if(mode==='enabled')mode=process.env.JUDGE0_URL?'judge0':process.env.RUNNER_URL&&process.env.RUNNER_TOKEN?'runner-api':'enabled';
 if(mode==='judge0'){
  if(!process.env.JUDGE0_URL)throw new AppError(503,'Code execution is not configured. Set JUDGE0_URL to your Judge0 API endpoint.','RUNNER_UNAVAILABLE');
  const headers={};if(process.env.JUDGE0_API_KEY)headers['X-Auth-Token']=process.env.JUDGE0_API_KEY;
  if(process.env.JUDGE0_RAPIDAPI_KEY){headers['X-RapidAPI-Key']=process.env.JUDGE0_RAPIDAPI_KEY;headers['X-RapidAPI-Host']=process.env.JUDGE0_RAPIDAPI_HOST||new URL(process.env.JUDGE0_URL).hostname}
  return judge0Execute({language,sourceCode,input,limits,baseUrl:process.env.JUDGE0_URL,headers});
 }
 if(mode==='enabled')throw new AppError(503,'Code execution is marked enabled, but no judge is configured. Set JUDGE0_URL or both RUNNER_URL and RUNNER_TOKEN.','RUNNER_UNAVAILABLE');
 if(mode!=='runner-api'||!process.env.RUNNER_URL||!process.env.RUNNER_TOKEN)throw new AppError(503,'Code execution is not configured. Configure an isolated Judge0 service before enabling matches.','RUNNER_UNAVAILABLE');
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(process.env.CODE_TIMEOUT_MS||3000)+1000);
 try{const response=await fetch(`${process.env.RUNNER_URL.replace(/\/$/,'')}/v1/execute`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.RUNNER_TOKEN}`},body:JSON.stringify({language,sourceCode,input,limits:{timeMs:Number(limits.timeMs||process.env.CODE_TIMEOUT_MS||3000),memoryMb:Number(limits.memoryMb||process.env.CODE_MEMORY_MB||128),outputBytes:Number(process.env.CODE_OUTPUT_BYTES||65536),network:false}}),signal:controller.signal});if(!response.ok)throw new AppError(502,'Isolated runner rejected the execution request.','RUNNER_ERROR');return await response.json()}catch(error){if(error.name==='AbortError')throw new AppError(504,'Code execution timed out.','EXECUTION_TIMEOUT');throw error}finally{clearTimeout(timeout)}
}
module.exports={execute,normalizeJudge0};
