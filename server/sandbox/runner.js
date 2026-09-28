const {AppError}=require('../errors');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const judge0LanguageIds={c:Number(process.env.JUDGE0_C_LANGUAGE_ID||50),cpp:Number(process.env.JUDGE0_CPP_LANGUAGE_ID||54)};

function bounded(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}
function normalizeJudge0(result){
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
  const base=baseUrl.replace(/\/+$/,'');
  const response=await fetch(`${base}/submissions?base64_encoded=false&wait=false`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({language_id:languageId,source_code:sourceCode,stdin:input,cpu_time_limit:cpuSeconds,cpu_extra_time:1,wall_time_limit:Math.min(cpuSeconds+3,20),memory_limit:memoryKb,stack_limit:Math.min(memoryKb,65536),max_processes_and_or_threads:20,enable_network:false}),signal:controller.signal});
  if(!response.ok){const body=await response.text();throw new AppError(response.status===429||response.status===503?503:502,`Judge service refused the run (${response.status}). ${body.slice(0,300)}`,'RUNNER_ERROR')}
  const created=await response.json();
  if(created.status?.id)return normalizeJudge0(created);
  if(!created.token)throw new AppError(502,'Judge did not return a submission token.','RUNNER_ERROR');
  const pollEvery=bounded(process.env.JUDGE0_POLL_INTERVAL_MS,200,2000,400);
  const deadline=Date.now()+totalWaitMs-1000;
  while(Date.now()<deadline){
   await sleep(Math.min(pollEvery,Math.max(50,deadline-Date.now())));
   const polled=await fetch(`${base}/submissions/${encodeURIComponent(created.token)}?base64_encoded=false&fields=stdout,stderr,compile_output,message,status,time,memory`,{headers,signal:controller.signal});
   if(!polled.ok)throw new AppError(502,'Could not retrieve the judge result.','RUNNER_ERROR');
   const result=await polled.json();
   if(result.status?.id>=3)return normalizeJudge0(result);
  }
  throw new AppError(504,'Execution took too long. Try again or simplify the program.','EXECUTION_TIMEOUT');
 }catch(error){if(error.name==='AbortError')throw new AppError(504,'Execution timed out. The judge did not respond in time.','EXECUTION_TIMEOUT');if(error instanceof AppError)throw error;throw new AppError(502,'Could not connect to the isolated code judge. Check the judge URL and service status.','RUNNER_ERROR')}finally{clearTimeout(timer)}
}

async function execute({language,sourceCode,input,limits={}}){
 const mode=process.env.EXECUTION_MODE||'disabled';
 if(mode==='judge0'){
  if(!process.env.JUDGE0_URL)throw new AppError(503,'Code execution is not configured. Set JUDGE0_URL to your Judge0 API endpoint.','RUNNER_UNAVAILABLE');
  const headers={};if(process.env.JUDGE0_API_KEY)headers['X-Auth-Token']=process.env.JUDGE0_API_KEY;
  if(process.env.JUDGE0_RAPIDAPI_KEY){headers['X-RapidAPI-Key']=process.env.JUDGE0_RAPIDAPI_KEY;headers['X-RapidAPI-Host']=process.env.JUDGE0_RAPIDAPI_HOST||new URL(process.env.JUDGE0_URL).hostname}
  return judge0Execute({language,sourceCode,input,limits,baseUrl:process.env.JUDGE0_URL,headers});
 }
 if(mode!=='runner-api'||!process.env.RUNNER_URL||!process.env.RUNNER_TOKEN)throw new AppError(503,'Code execution is not configured. Configure an isolated Judge0 service before enabling matches.','RUNNER_UNAVAILABLE');
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(process.env.CODE_TIMEOUT_MS||3000)+1000);
 try{const response=await fetch(`${process.env.RUNNER_URL.replace(/\/$/,'')}/v1/execute`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.RUNNER_TOKEN}`},body:JSON.stringify({language,sourceCode,input,limits:{timeMs:Number(limits.timeMs||process.env.CODE_TIMEOUT_MS||3000),memoryMb:Number(limits.memoryMb||process.env.CODE_MEMORY_MB||128),outputBytes:Number(process.env.CODE_OUTPUT_BYTES||65536),network:false}}),signal:controller.signal});if(!response.ok)throw new AppError(502,'Isolated runner rejected the execution request.','RUNNER_ERROR');return await response.json()}catch(error){if(error.name==='AbortError')throw new AppError(504,'Code execution timed out.','EXECUTION_TIMEOUT');throw error}finally{clearTimeout(timeout)}
}
module.exports={execute,normalizeJudge0};
