import puppeteer from "puppeteer";
import fs from "fs/promises";

async function run() {
  await fs.mkdir("out/__tmp-magicui-shots", { recursive: true });
  
  const browser = await puppeteer.launch({
    executablePath: process.env.USERPROFILE + "\\.cache\\puppeteer\\chrome\\win64-131.0.6778.204\\chrome-win64\\chrome.exe",
    headless: true,
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  console.log("Navigating to page...");
  // Assuming the user has vite running
  await page.goto("http://127.0.0.1:5191/?export=1&timeline=/__tmp-magicui.json");
  
  console.log("Waiting for window.__pcReady...");
  await page.waitForFunction("window.__pcReady === true");
  
  async function checkTime(t) {
    console.log(`\n--- Checking t = ${t}s ---`);
    await page.evaluate((t) => window.__pcSetT(t), t);
    // wait 2 rAFs
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    
    // ensure images decode
    await page.evaluate(() => Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))));

    await page.screenshot({ path: `out/__tmp-magicui-shots/t-${t}.png` });
    
    const result = await page.evaluate(() => {
      const stage = document.querySelector('.pc-stage');
      const text = stage ? stage.innerText : '';
      
      const elements = {
        numberTicker: document.querySelector('.tabular-nums'),
        blurFade: document.querySelector('h2'),
        circularProgressCircle: document.querySelectorAll('circle')[1],
        typing: document.querySelector('h1'),
        wordRotate: document.querySelector('h1') // Depending on card
      };
      
      return {
        text,
        numberTickerText: elements.numberTicker ? elements.numberTicker.textContent : null,
        numberTickerSize: elements.numberTicker ? window.getComputedStyle(elements.numberTicker).fontSize : null,
        blurFadeSize: elements.blurFade ? window.getComputedStyle(elements.blurFade).fontSize : null,
        strokeOffset: elements.circularProgressCircle ? elements.circularProgressCircle.style.strokeDashoffset : null,
        typingText: elements.typing ? elements.typing.textContent : null,
        typingSize: elements.typing ? window.getComputedStyle(elements.typing).fontSize : null,
      };
    });
    
    console.log("Collected:", result);
    return result;
  }
  
  const results = {};
  
  results["0.3"] = await checkTime(0.3);
  results["1.6"] = await checkTime(1.6);
  results["2.3"] = await checkTime(2.3);
  results["3.6"] = await checkTime(3.6);
  results["4.3"] = await checkTime(4.3);
  results["5.6"] = await checkTime(5.6);
  results["6.3"] = await checkTime(6.3);
  results["7.6"] = await checkTime(7.6);
  results["8.3"] = await checkTime(8.3);
  results["9.6"] = await checkTime(9.6);
  
  await browser.close();
  
  console.log("\n--- Validation ---");
  
  function assert(condition, message) {
    if (condition) {
      console.log(`PASS: ${message}`);
    } else {
      console.error(`FAIL: ${message}`);
    }
  }
  
  // mu-number-ticker
  assert(results["0.3"].numberTickerText !== results["1.6"].numberTickerText, `Number ticker moving: ${results["0.3"].numberTickerText} -> ${results["1.6"].numberTickerText}`);
  assert(parseFloat(results["1.6"].numberTickerText) > 80, `Number ticker near 100 at 1.6s: ${results["1.6"].numberTickerText}`);
  assert(results["1.6"].numberTickerSize === "200px", `Number ticker size is 200px (was ${results["1.6"].numberTickerSize})`);
  
  // mu-blur-fade
  assert(results["2.3"].text.includes("你好世界"), `Blur fade shows text at 2.3s: ${results["2.3"].text}`);
  assert(results["2.3"].blurFadeSize === "96px", `Blur fade size is 96px (was ${results["2.3"].blurFadeSize})`);
  
  // mu-circular-progress
  const offset1 = parseFloat(results["4.3"].strokeOffset);
  const offset2 = parseFloat(results["5.6"].strokeOffset);
  assert(!isNaN(offset1) && !isNaN(offset2) && offset1 !== offset2, `Circular progress moving: ${offset1} -> ${offset2}`);
  const circumference = 2 * Math.PI * 45; // ~282.74
  const expectedEndOffset = circumference - (circumference * 0.75); // ~70.68
  assert(Math.abs(offset2 - expectedEndOffset) < 5, `Circular progress near 75% at 5.6s (offset: ${offset2}, expected: ~${expectedEndOffset})`);
  
  // mu-typing
  const typeText1 = results["6.3"].typingText || "";
  const typeText2 = results["7.6"].typingText || "";
  assert(typeText1.length < typeText2.length, `Typing animation progressing: "${typeText1}" -> "${typeText2}"`);
  assert(results["7.6"].typingSize === "80px", `Typing animation size is 80px (was ${results["7.6"].typingSize})`);
  
  // mu-word-rotate
  const word1 = results["8.3"].text;
  const word2 = results["9.6"].text;
  assert(word1 !== word2, `Word rotate changing: "${word1}" -> "${word2}"`);
  
  console.log("Validation complete.");
}

run().catch(console.error);
