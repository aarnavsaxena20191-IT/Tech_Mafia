const {AppError}=require('../errors');
function validate(schema,source='body'){return(req,_res,next)=>{const parsed=schema.safeParse(req[source]);if(!parsed.success)return next(new AppError(400,parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '),'INVALID_INPUT'));req[source]=parsed.data;next()}}
module.exports={validate};
