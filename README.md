# node-red-contrib-vnc
Node-red node allowing control of a VNC Server

*N.B. This has been thrown together for a personal project and it's most-likely not efficent and doesn't have much error handling! I have released it as I cannot find VNC nodes elsewhere so it may be useful to others for similar purposes. I will try to release updates when time permits*

##20260808 fix by ai
加入了以下功能：

1. 喚醒 VNC 伺服器：在進行截圖前，先透過 VNC 客戶端執行滑鼠點擊（座標 x=1, y=1，左鍵按下 50ms 後釋放），以喚醒可能進入休眠的 VNC 伺服器。  
2. 截圖後 3 分鐘自動斷線：與先前的需求相同，截圖完成後會啟動 3 分鐘（180,000 毫秒）計時器，計時結束時呼叫客戶端的 disconnect() 方法並更新節點狀態為「已斷線」。  
3. 重複觸發時重新連線：每次收到輸入訊息時，都會先確保連線（呼叫 connect()），執行喚醒點擊，進行截圖，然後重新計時，因而能達到「觸發時連線、截圖後 3 分鐘斷線，下次觸發時重新連線」的循環。



## 20260807 fix by ai
* 連線在伺服器逾時或網路短暫中斷時，會被正確偵測並自動重新連線（在下一次執行 perform 時）。  
* 節點狀態圖示會即時反映真實的連線狀況（綠＝連線中，黃＝連線中，紅＝錯誤/斷線）。  
* screenshot 節點不再因字串轉義錯誤而無法載入，且在客戶端或 RFB 實例缺失時會給出明確錯誤訊息。  
* 長時間運行後，不再需要手動斷線再連線才能擷取畫面。


## Current Nodes
* **vnc-client** - Configuration node containing server details
* **info** - Gets server info (name, height and width)
* **keyboard** - Allows sending of key presses or strings to the remote server
* **mouse** - Allows sending of mouse movememnts and button presses to the remote server
* **clipboard** - Allows sending or receiving of clipboard to/from the remote server
* **screenshot** - Returns a screenshot from the remote server as a PNG buffer

## To-Do
* Change credentials to use Node's credentials functions
* Example flows to follow

## Pre-requesites
None!

## Credits
* **node-rfb2** - https://github.com/sidorares/node-rfb2
* **JIMP** - https://github.com/oliver-moran/jimp
