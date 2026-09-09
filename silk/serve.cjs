const h=require('http'),f=require('fs');
h.createServer((q,res)=>{
  try{ const b=f.readFileSync('C:/Users/yashd/Downloads/SIH/silk/silk-hero.html');
       res.writeHead(200,{'content-type':'text/html'}); res.end(b); }
  catch(e){ res.writeHead(500); res.end(String(e)); }
}).listen(8931,'127.0.0.1',()=>console.log('up'));
