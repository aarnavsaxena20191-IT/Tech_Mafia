const {models}=require('../db');
async function getTeamForUser(userId){const team=await models.Team.findOne({'members.user_id':userId}).lean();if(!team)return null;const member=team.members.find(m=>m.user_id===userId);return{id:team._id,name:team.name,code:team.code,tournament_id:team.tournament_id,group_name:team.group_name,member_number:member?.member_number}}
async function getMatchAccess(userId,matchId){const team=await getTeamForUser(userId);const match=team?await models.Match.findOne({_id:matchId,'participants.team_id':team.id}).lean():null;return{team,match}}
module.exports={getTeamForUser,getMatchAccess};
