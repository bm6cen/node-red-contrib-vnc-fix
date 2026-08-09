#forked from Rizzlar/node-red-contrib-vnc since 202608


# node-red-contrib-vnc
Node-red node allowing control of a VNC Server

*N.B. This has been thrown together for a personal project and it's most-likely not efficent and doesn't have much error handling! I have released it as I cannot find VNC nodes elsewhere so it may be useful to others for similar purposes. I will try to release updates when time permits*

##20260809 fix by ai
加入了以下功能：

加入 喚醒序列：滑鼠移至 (0,0) → (1,1) → 在 (0,0) 點擊兩次（延遲 1.5 秒），以喚醒可能處於休眠的 VNC 伺服器。  
   - 使用 client.getFreshFrame()（逾時 2.5 秒）要求完整畫面更新，確保取得最新畫面。  
   - 截圖完成後進行 黑畫面偵測：若像素中 ≥90% 為近似黑色（R、G、B < 10），則視為未喚醒，最多重試 3 次（每次重新喚醒後再擷取）。  
   - 新增 畫面比對：將本次擷取的 PNG 與同一 VNC 伺服器上一次成功擷取的畫面進行位元組比對。若完全相同，則重試最多 3 次；超過重試次數後會 斷線後重新連線（呼叫 client.disconnect() 待 1 秒後再次進行擷取流程）。  
   - 成功擷取後會將該畫面儲存為該 VNC 客戶端的「最後一幀」，並啟動 3 分鐘自動斷線計時器（計時到期呼叫 client.disconnect() 並將節點狀態設為 disconnected）。  
   - 加入 busy 標籤防止重複觸發，節點關閉時會清理所有 rect 監聽器與計時器。



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
*  **Rizzlar** -https://github.com/Rizzlar/node-red-contrib-vnc
