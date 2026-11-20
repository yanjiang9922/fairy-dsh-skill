# Fairy 语音参考来源

这些视频仅用于核对 Fairy 的语气、语速和停顿，并生成本机个人试听素材。
《绝区零》角色、台词和声音权利归 miHoYo / HoYoverse 所有。

## 干净参考声线

- [《绝区零》Fairy 待机语音合集](https://www.bilibili.com/video/BV1KQa3eSE4V)
  - Fairy 平静说明与待机语气
  - Fairy 温和、叮嘱与调侃语气
  - 用于 `ref-neutral`、`ref-warm`、`ref-focused`、`ref-alert`、`ref-playful`

## 剧情与性格核对

- [3.3 Fairy 出场片段](https://www.bilibili.com/video/BV17bno6GEeG)
  - 00:03.9–00:07.4：重逢与确认
  - 00:41.0–00:58.6：连续信息汇报
  - 00:70.5–00:76.6：无法提供信息时的克制致歉
  - 09:11.0–09:18.0：空间不稳定时的短停顿和预警语气
  - 12:09.3–12:14.3：定位硬件故障时的快速说明

- [Fairy：你看，主人你又急](https://www.bilibili.com/video/BV1bM4m127tc)
  - 00:41.0–00:46.1：冷静吐槽与“没有吃醋机能”的平直尾音
  - 01:15.9–01:30.1：短句、递进停顿和轻微上扬
  - 03:21.3–03:29.5：降低语速后的最后一句，适合结束汇报

- [HDD 系统挂机彩蛋](https://www.bilibili.com/video/BV131421k7xW)
  - Fairy 傲娇、腹黑和在严肃汇报里突然转折的表达方式

- [Fairy 自述片段](https://www.bilibili.com/video/BV15c411r7Py)
  - “三型总序式集成泛用人工智能”与向主人报到的标准自我识别语气

## 当前取舍

剧情实机录音带有音乐、环境声和其他角色，直接替换参考声线会明显降低合成
稳定性。因此模型仍使用干净待机语音作声线锚点，剧情片段只用于校对语速、
停顿和情绪切换；实际情绪差异由 `warm`、`focused`、`alert`、`playful`
四组参考与推理参数共同完成。
