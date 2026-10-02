'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 100_000;
const TEXT_LIMIT = 2000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const STARTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'starts.json'), 'utf8'));
const MISSIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'missions.json'), 'utf8'));
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
if (!fs.existsSync(ROOMS_FILE)) fs.writeFileSync(ROOMS_FILE, '{}');
let rooms = loadRooms();
let saveTimer = null;

function loadRooms(){
  try { return JSON.parse(fs.readFileSync(ROOMS_FILE,'utf8')) || {}; }
  catch { return {}; }
}
function persistSoon(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    const tmp=ROOMS_FILE+'.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rooms,null,2));
    fs.renameSync(tmp, ROOMS_FILE);
  },50);
}
function id(bytes=12){ return crypto.randomBytes(bytes).toString('hex'); }
function roomCode(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for(let tries=0;tries<30;tries++){
    let c=''; for(let i=0;i<5;i++) c+=alphabet[crypto.randomInt(alphabet.length)];
    if(!rooms[c]) return c;
  }
  return crypto.randomBytes(4).toString('hex').slice(0,5).toUpperCase();
}
function cleanName(v){ return String(v||'').trim().replace(/\s+/g,' ').slice(0,32); }
function cleanTitle(v){ return String(v||'').trim().replace(/\s+/g,' ').slice(0,80); }
function randomOf(arr){ return arr[crypto.randomInt(arr.length)]; }
function playerByToken(room, token){ return room.players.find(p=>p.token===token); }
function currentPlayer(room){ return room.players[room.playerCursor % room.players.length]; }
function ensureMission(room){
  if(room.mode!=='saboteur' || room.status!=='playing') { room.currentMission=null; return; }
  const p=currentPlayer(room);
  if(room.currentMission && room.currentMission.playerId===p.id) return;
  let available=MISSIONS.filter(m=>!room.usedMissionIds.includes(m.id));
  if(!available.length){ room.usedMissionIds=[]; available=MISSIONS.slice(); }
  const m=randomOf(available);
  room.usedMissionIds.push(m.id);
  room.currentMission={playerId:p.id, missionId:m.id, text:m.text};
}
function publicState(room, token){
  const me=playerByToken(room,token);
  const cp=room.status==='playing' ? currentPlayer(room) : null;
  const common={
    code:room.code,status:room.status,mode:room.mode,genre:room.genre,title:room.title,
    maxTurns:room.maxTurns,writtenTurns:room.writtenTurns,
    players:room.players.map(p=>({id:p.id,name:p.name,isHost:p.id===room.hostPlayerId})),
    hostPlayerId:room.hostPlayerId,currentPlayer:cp?{id:cp.id,name:cp.name}:null,
    me:me?{id:me.id,name:me.name,isHost:me.id===room.hostPlayerId}:null,
    canStart:!!me && me.id===room.hostPlayerId && room.status==='lobby' && room.players.length>=3,
    canSkip:!!me && me.id===room.hostPlayerId && room.status==='playing',
    serverTime:Date.now()
  };
  if(room.status==='playing' && me && cp && me.id===cp.id){
    common.yourTurn=true;
    common.previousLabel=room.writtenTurns===0?'Стартовая сцена':'Предыдущий фрагмент';
    common.previousText=room.writtenTurns===0?room.startScene:room.fragments[room.fragments.length-1].text;
    if(room.mode==='saboteur') common.mission=room.currentMission?.text || null;
  } else common.yourTurn=false;
  if(room.status==='final'){
    common.story=[room.startScene,...room.fragments.map(f=>f.text)].join('\n\n');
    common.byAuthor=room.fragments.map(f=>({turn:f.turn,playerId:f.playerId,playerName:f.playerName,text:f.text}));
    common.startScene=room.startScene;
    if(room.mode==='saboteur') common.reveals=room.fragments.map(f=>({turn:f.turn,playerId:f.playerId,playerName:f.playerName,mission:f.missionText||'—'}));
  }
  return common;
}
function json(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body);
}
function readJson(req){
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data',chunk=>{ data+=chunk; if(data.length>MAX_BODY){ reject(new Error('too_large')); req.destroy(); }});
    req.on('end',()=>{ try{ resolve(data?JSON.parse(data):{}); }catch(e){ reject(e); }});
    req.on('error',reject);
  });
}
function tokenFrom(req,url,body){ return String(req.headers['x-player-token'] || url.searchParams.get('token') || body?.token || ''); }
function notFound(res){ json(res,404,{error:'not_found'}); }
function error(res,status,msg){ json(res,status,{error:msg}); }

async function api(req,res,url){
  const parts=url.pathname.split('/').filter(Boolean);
  let body={}; if(req.method==='POST') { try{body=await readJson(req)}catch{return error(res,400,'invalid_json')} }

  if(req.method==='GET' && url.pathname==='/api/meta'){
    return json(res,200,{genres:Object.keys(STARTS),modes:['classic','saboteur'],minPlayers:3,textLimit:TEXT_LIMIT});
  }
  if(req.method==='POST' && url.pathname==='/api/rooms'){
    const name=cleanName(body.name), mode=body.mode==='saboteur'?'saboteur':'classic', genre=String(body.genre||'');
    const maxTurns=Math.max(3,Math.min(30,Number(body.maxTurns)||9));
    if(!name) return error(res,400,'name_required');
    if(!STARTS[genre]) return error(res,400,'genre_invalid');
    const code=roomCode(), p={id:id(8),token:id(18),name,joinedAt:Date.now()};
    const room={code,mode,genre,title:cleanTitle(body.title),maxTurns,status:'lobby',createdAt:Date.now(),hostPlayerId:p.id,players:[p],playerCursor:0,writtenTurns:0,startScene:null,fragments:[],usedMissionIds:[],currentMission:null};
    rooms[code]=room; persistSoon();
    return json(res,201,{code,token:p.token,state:publicState(room,p.token)});
  }
  if(parts[0]==='api' && parts[1]==='rooms' && parts[2]){
    const code=parts[2].toUpperCase(), room=rooms[code]; if(!room) return error(res,404,'room_not_found');
    const action=parts[3]||'';
    if(req.method==='POST' && action==='join'){
      if(room.status!=='lobby') return error(res,409,'game_already_started');
      const name=cleanName(body.name); if(!name) return error(res,400,'name_required');
      const existing=room.players.find(p=>p.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
      if(existing) return error(res,409,'name_taken');
      if(room.players.length>=20) return error(res,409,'room_full');
      const p={id:id(8),token:id(18),name,joinedAt:Date.now()}; room.players.push(p); persistSoon();
      return json(res,200,{code,token:p.token,state:publicState(room,p.token)});
    }
    const token=tokenFrom(req,url,body), me=playerByToken(room,token);
    if(req.method==='GET' && action==='state'){
      if(me) me.lastSeen=Date.now(); return json(res,200,publicState(room,token));
    }
    if(!me) return error(res,401,'player_token_invalid');
    if(req.method==='POST' && action==='start'){
      if(me.id!==room.hostPlayerId) return error(res,403,'host_only');
      if(room.status!=='lobby') return error(res,409,'already_started');
      if(room.players.length<3) return error(res,409,'need_three_players');
      room.status='playing'; room.playerCursor=0; room.writtenTurns=0; room.fragments=[]; room.usedMissionIds=[];
      room.startScene=randomOf(STARTS[room.genre]); ensureMission(room); persistSoon();
      return json(res,200,publicState(room,token));
    }
    if(req.method==='POST' && action==='submit'){
      if(room.status!=='playing') return error(res,409,'not_playing');
      const cp=currentPlayer(room); if(me.id!==cp.id) return error(res,403,'not_your_turn');
      const text=String(body.text||'').trim(); if(!text) return error(res,400,'text_required');
      if(text.length>TEXT_LIMIT) return error(res,400,'text_too_long');
      const mission=room.mode==='saboteur'?room.currentMission:null;
      room.writtenTurns++;
      room.fragments.push({turn:room.writtenTurns,playerId:me.id,playerName:me.name,text,missionId:mission?.missionId||null,missionText:mission?.text||null,createdAt:Date.now()});
      if(room.writtenTurns>=room.maxTurns){ room.status='final'; room.currentMission=null; }
      else { room.playerCursor=(room.playerCursor+1)%room.players.length; room.currentMission=null; ensureMission(room); }
      persistSoon(); return json(res,200,publicState(room,token));
    }
    if(req.method==='POST' && action==='skip'){
      if(me.id!==room.hostPlayerId) return error(res,403,'host_only');
      if(room.status!=='playing') return error(res,409,'not_playing');
      if(room.players.length<2) return error(res,409,'cannot_skip');
      room.playerCursor=(room.playerCursor+1)%room.players.length; room.currentMission=null; ensureMission(room); persistSoon();
      return json(res,200,publicState(room,token));
    }
    if(req.method==='POST' && action==='leave'){
      if(room.status!=='lobby') return error(res,409,'cannot_leave_after_start');
      room.players=room.players.filter(p=>p.id!==me.id);
      if(!room.players.length){ delete rooms[code]; persistSoon(); return json(res,200,{ok:true,roomDeleted:true}); }
      if(me.id===room.hostPlayerId) room.hostPlayerId=room.players[0].id;
      persistSoon(); return json(res,200,{ok:true});
    }
    return notFound(res);
  }
  notFound(res);
}

const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function serveStatic(req,res,url){
  let rel=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
  const fp=path.resolve(PUBLIC,'.'+rel);
  if(!fp.startsWith(path.resolve(PUBLIC))) return error(res,403,'forbidden');
  fs.stat(fp,(err,st)=>{
    if(err||!st.isFile()) { const index=path.join(PUBLIC,'index.html'); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return fs.createReadStream(index).pipe(res); }
    res.writeHead(200,{'Content-Type':mime[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':path.extname(fp)==='.html'?'no-cache':'public, max-age=3600'}); fs.createReadStream(fp).pipe(res);
  });
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname.startsWith('/api/')) api(req,res,url).catch(e=>{console.error(e); if(!res.headersSent) error(res,500,'server_error');});
  else serveStatic(req,res,url);
});
server.listen(PORT,'0.0.0.0',()=>console.log(`ТБГ игра: http://localhost:${PORT}`));
