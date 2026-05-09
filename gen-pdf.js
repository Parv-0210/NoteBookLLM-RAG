import PDFDocument from 'pdfkit';
import fs from 'fs';

const doc = new PDFDocument();
doc.pipe(fs.createWriteStream('node-js.pdf'));

doc.fontSize(25).text('Node.js Debugging Guide', 100, 100);
doc.fontSize(12).text('1. Using Node.js built-in debugger:\nNode.js has a built-in debugger that integrates with Chrome Developer Tools.\n- Start your application with the "inspect" flag:\n\nnode inspect app.js\n\n- Then, open Chrome and visit: chrome://inspect\n- You will see a list of Node.js processes you can debug. Click "inspect" next to your process to open developer tools.\n- Set breakpoints in your code where you want execution to pause.', 100, 150);

doc.moveDown();
doc.text('Example of adding a breakpoint programmatically:\n\nconsole.log("Thing one");\ndebugger; // The debugger will pause here until you resume execution\nconsole.log("Thing two");\n\nThis approach lets you explore application state, step through code, and find bugs more effectively than console.log alone.', { align: 'left' });

doc.end();
console.log('Dummy PDF created.');
