const {AppError}=require('../errors');
function notFound(_req,_res,next){next(new AppError(404,'Resource not found.','NOT_FOUND'))}
function errorHandler(err,req,res,_next){const status=err.status||500;if(status>=500)console.error(err);const safeMessage=status>=500?(process.env.NODE_ENV==='production'?'The server could not complete this request. Check the service logs and share request ID '+req.id+' with the organizer.':'The server could not complete this request: '+(err.message||'Unknown error')):err.message;res.status(status).json({error:{code:err.code||'INTERNAL_ERROR',message:safeMessage,requestId:req.id}})}
module.exports={notFound,errorHandler};
