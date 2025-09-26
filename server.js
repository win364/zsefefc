// Vercel Serverless Function for CAVEMINES game
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body);
  if (body == null) return res.end();
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(data||'{}')); } catch { cb({}); } });
  req.on('error', () => cb({}));
}

// -------- Local API store --------
const Store = {
  user: { language: 'ru', currency: 'RUB', sessionId: null, balance: 1000.00, name: 'Игрок', avatar: '', exchangeRate: 1 },
  settings: {
    supportedCurrencies: ['RUB'],
    bets: { RUB: { quickBets: { min: 1, max: 20000 }, defaultBet: 100, steps: [] } },
    presets: [{ presetValue: 3, isDefault: true }],
    rates: [{ presetValue: 3, rates: [1.09,1.24,1.43,1.65,1.93,2.27,2.69,3.23,3.92] }],
    roundsCount: 25,
    gameName: 'КАВЕМИНЫ',
    gameDescription: 'Игра в мины с реальными ставками',
    currencySymbol: '₽',
    language: 'ru'
  },
  activeSession: null,
  history: [],
};

function getRates(preset) {
  const e = (Store.settings.rates||[]).find(r=>r.presetValue===preset);
  return e ? e.rates.slice() : [];
}

function randomBombs(traps) {
  const set = new Set();
  while (set.size < Math.min(traps,25)) {
    const col = Math.floor(Math.random()*5); const row = Math.floor(Math.random()*5);
    set.add(`${col},${row}`);
  }
  const expectedChoices = [];
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) expectedChoices.push({ value:{col:c,row:r}, category: set.has(`${c},${r}`)?1:0 });
  return { bombs:set, expectedChoices };
}

function bombMatrixFromSet(bombs) {
  const m = Array.from({length:5},()=>Array(5).fill(0));
  for (let r=0;r<5;r++) for (let c=0;c<5;c++) { if (bombs.has(`${c},${r}`)) m[r][c]=1; }
  return m;
}

function generateSaltAndHash(bombs) {
  const left = Math.random().toString(16).slice(2);
  const right = Math.random().toString(16).slice(2);
  const matrix = bombMatrixFromSet(bombs);
  const salt = `${left}|${JSON.stringify(matrix)}|${right}`;
  const hash = crypto.createHash('sha256').update(salt).digest('hex');
  return { salt, hash };
}

function buildSession(amount, presetValue) {
  const id = Math.random().toString(36).slice(2)+Date.now().toString(36);
  const { bombs, expectedChoices } = randomBombs(presetValue||3);
  const { salt, hash } = generateSaltAndHash(bombs);
  const coeffs = getRates(presetValue||3);
  return {
    id, state:'Active', bet:amount, hash, salt, lastRound:0, coefficient:0, availableCashout:0,
    startDate:new Date().toISOString(), endDate:'', currency:Store.user.currency,
    gameData:{ presetValue:presetValue||3, coefficients:coeffs, userChoices:[], expectedChoices, currentRoundId:0, rounds:[{id:0,amount:0,availableCash:0,odd:1}] },
    _internal:{ bombs }
  };
}

function finishRound(session, click){
  const key = `${click.col},${click.row}`; const isBomb = session._internal.bombs.has(key);
  const next = session.lastRound + 1; const coeff = session.gameData.coefficients[Math.max(0,next-1)] || session.coefficient || 0;
  session.gameData.userChoices.push({ value:{col:click.col,row:click.row}, category: isBomb?1:0 });
  session.lastRound = next; session.coefficient = isBomb ? session.coefficient : coeff;
  session.gameData.currentRoundId = next;
  session.gameData.rounds.push({ id: next, amount: session.bet, availableCash: Math.round(session.bet * (isBomb? session.coefficient : coeff)), odd: session.coefficient });
  if (isBomb) { 
    session.state='Loss'; 
    session.availableCashout=0; 
    session.endDate=new Date().toISOString(); 
  }
  else { 
    session.availableCashout = Math.round(session.bet * session.coefficient); 
    if (next>=session.gameData.coefficients.length){ 
      session.state='Win'; 
      session.endDate=new Date().toISOString(); 
      if (!session._internal.paid) {
        Store.user.balance = Math.round((Store.user.balance + session.availableCashout) * 100) / 100;
        session._internal.paid = true;
      }
    } 
  }
}

function cashout(){ 
  const s=Store.activeSession; 
  if(!s) return; 
  if(s.state==='Active'&&s.availableCashout>0){ 
    Store.user.balance = Math.round((Store.user.balance + s.availableCashout) * 100) / 100; 
    s.state='Win'; 
    s.endDate=new Date().toISOString(); 
  }
  Store.history.unshift(publicSession(s));
  Store.activeSession = null;
}

function publicSession(s){ if(!s) return {}; const {_internal,...rest}=s; return rest; }

// -------- API handler --------
function handleApi(req,res){
  return new Promise((resolve) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname; const m = req.method;
    
    if(p==='/mines/user'&&m==='GET'){ 
      const userData = {
        language: 'ru',
        currency: 'RUB',
        sessionId: Store.user.sessionId,
        balance: Store.user.balance,
        name: 'Игрок',
        avatar: '',
        exchangeRate: 1
      };
      send(res,200,userData,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true); 
    }
    
    if(p==='/mines/settings'&&m==='GET'){ 
      send(res,200,Store.settings,{ 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' }); 
      return resolve(true); 
    }
    
    if(p==='/mines/sessions'&&m==='GET'){
      send(res,200,{ limit:30, offset:0, data:Store.history.slice(0,30) },{ 'Content-Type':'application/json' });
      return resolve(true);
    }
    
    if(p==='/mines/session'&&m==='POST'){
      readJson(req, body=>{
        const amount=Number(body.amount||0), preset=Number(body.presetValue||3);
        const qb = Store.settings.bets[Store.user.currency]?.quickBets || { min:1,max:20000 };
        
        if(amount<qb.min) { send(res,400,{ error:{ type:'smallBid', header:'Ставка ниже минимума', message:'Ставка ниже минимально допустимой суммы' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>qb.max) { send(res,400,{ error:{ type:'highBid', header:'Ставка выше максимума', message:'Ставка превышает максимально допустимую сумму' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(amount>Store.user.balance) { send(res,400,{ error:{ type:'insufficientFunds', header:'Недостаточно средств', message:'На вашем счету недостаточно средств для этой ставки' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        if(Store.activeSession) { send(res,400,{ error:{ type:'activeSessionExists', header:'Активная сессия уже существует', message:'У вас уже есть активная игровая сессия' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        
        Store.user.balance = Math.round((Store.user.balance - amount) * 100) / 100;
        Store.activeSession = buildSession(amount, preset);
        Store.user.sessionId = Store.activeSession.id;
        send(res,200,publicSession(Store.activeSession),{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return;
    }
    
    if(p==='/mines/round'&&m==='PUT'){
      readJson(req, body=>{
        if(!Store.activeSession) {
          const neutral = {
            userChoices: [],
            state: 'Not started',
            availableCashout: 0,
            coefficient: 0,
            lastRound: 0,
            gameData: {
              currentRoundId: 0,
              availableCashout: false,
              rounds: [],
              coefficients: [],
              expectedChoices: []
            }
          };
          send(res,200,neutral,{ 'Content-Type':'application/json' });
          return resolve(true);
        }
        const click={ col:Number(body.col), row:Number(body.row) };
        const dup = Store.activeSession.gameData.userChoices.some(c=>c.value.col===click.col&&c.value.row===click.row);
        if(dup) { send(res,400,{ error:{ type:'duplicateRound', message:'Эта ячейка уже была выбрана ранее' }},{ 'Content-Type':'application/json' }); return resolve(true);} 
        finishRound(Store.activeSession, click);
        const s = Store.activeSession;
        const payload = {
          userChoices: s.gameData.userChoices,
          state: s.state,
          availableCashout: s.availableCashout || 0,
          coefficient: s.coefficient || 0,
          lastRound: s.lastRound || 0,
          gameData: {
            currentRoundId: s.gameData.currentRoundId,
            availableCashout: s.availableCashout > 0,
            rounds: s.gameData.rounds,
            coefficients: s.gameData.coefficients,
            expectedChoices: s.gameData.expectedChoices
          }
        };
        send(res,200,payload,{ 'Content-Type':'application/json' });
        return resolve(true);
      });
      return;
    }
    
    if(/^\/mines\/session\//.test(p)&&m==='PUT'){ 
      cashout(); 
      send(res,200,Store.history[0]||{},{ 'Content-Type':'application/json' }); 
      return resolve(true); 
    }
    
    send(res,404,'API endpoint not found');
    return resolve(true);
  });
}

// HTTP Server handler
async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }
    
    if (p.startsWith('/mines/')) {
      if (p.includes('/mines/user') || p.includes('/mines/settings') || p.includes('/mines/session') || p.includes('/mines/round')) {
        await handleApi(req, res);
      } else {
        try {
          const gameHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
          send(res, 200, gameHtml, { 'Content-Type': 'text/html; charset=utf-8' });
        } catch (error) {
          send(res, 500, 'Игра не найдена');
        }
      }
    } else if (p === '/' || p === '/index.html') {
      res.writeHead(302, { Location: '/mines/' });
      res.end();
    } else if (p === '/manifest.json') {
      const manifest = {
        name: 'КАВЕМИНЫ - Игра в мины',
        short_name: 'КАВЕМИНЫ',
        start_url: '/mines/',
        display: 'standalone',
        theme_color: '#000000',
        background_color: '#1a1a2e',
        description: 'Игра в мины с реальными ставками',
        lang: 'ru',
        icons: [{ src: '/static/media/cells-mask.1a7021b147b7851ffef6.svg', sizes: 'any', type: 'image/svg+xml' }]
      };
      send(res, 200, manifest, { 'Content-Type': 'application/manifest+json' });
    } else {
      send(res,404,'Not found');
    }
  } catch (e) {
    console.error('[SERVER] Error:', e);
    send(res,500,'Internal Server Error');
  }
}

// Export for Vercel
module.exports = requestHandler;

// Start HTTP server for local development
if (require.main === module) {
  const http = require('http');
  const PORT = process.env.PORT || 8080;
  
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`🚀 КАВЕМИНЫ сервер запущен на порту ${PORT}`);
    console.log(`🎮 Игра доступна: http://localhost:${PORT}/mines/`);
    console.log(`💰 Баланс игрока: ${Store.user.balance} ₽`);
  });
}
