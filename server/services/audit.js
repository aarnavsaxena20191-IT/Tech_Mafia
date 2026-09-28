const {models}=require('../db');
async function audit(actorId,action,type,id,metadata={},ip){await models.AuditLog.create({actor_id:actorId||null,action,resource_type:type,resource_id:id||null,metadata,ip_address:ip||null})}
module.exports={audit};
