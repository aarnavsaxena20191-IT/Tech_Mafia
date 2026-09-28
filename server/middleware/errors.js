const {AppError}=require('../errors');
function notFound(_req,_res,next){next(new AppError(404,'Resource not found.','NOT_FOUND'))}
function errorHandler(err,req,res,_next){const status=err.status||500;if(status>=500)console.error(err);res.status(status).json({error:{code:err.code||'INTERNAL_ERROR',message:status>=500?'An unexpected server error occurred.':err.message,requestId:req.id}})}
module.exports={notFound,errorHandler};
