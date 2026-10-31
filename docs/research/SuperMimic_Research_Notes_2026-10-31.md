---
title: "SuperMimic：世界模型理解与单 GPU 算法改进研究计划"
aliases:
  - "SuperMimic 研究记录"
  - "World Model × Policy 研究路线"
date: 2026-10-31
updated: 2026-10-31
type: research-note
status: active
tags:
  - robotics
  - reinforcement-learning
  - model-based-rl
  - world-model
  - supermimic
  - single-gpu
---

# SuperMimic：世界模型理解与单 GPU 算法改进

> [!abstract] 一句话总结
> **先不做计算成本较高的 LLM / LLM Agent 强化学习实验，而是以 SuperMimic 为研究基准，在单张 Google Colab GPU 上建立可复现的训练流程，逐步研究世界模型压缩、BPTT 效率，以及更长远的 World Model–Policy 融合。**

> [!info] 记录说明
> 本笔记整理自 2026-10-30 至 2026-10-31 关于 SuperMimic、World Model、Model-Based RL 和后续研究方向的讨论。**“论文报告”“我们的理解”“研究假设”三者严格区分。** 此处不是独立的论文复现报告；论文配置和社区实现的细节，在实验前应回到原始 TeX、代码及 commit 逐项核对。

## 一、已经达成的研究共识

- **研究对象**：SuperMimic（人形机器人全身控制、可微世界模型、基于 BPTT 的策略优化）。
- **当前资源约束**：主要使用 **Google Colab 的单张 GPU**；不假设有 H100、固定显存容量或无限运行时间。
- **短期不做**：LLM / LLM Agent 的大型 RL post-training 实验；相关思想仅作为远期研究灵感。
- **优先级**：可复现基准 → 定位瓶颈 → 逐项算法改进 → 再尝试统一模型与端到端联合训练。
- **衡量标准**：不以“网络变小”或“参数更少”作为成功依据，而以**相同控制质量下所需 GPU-hours、实际训练吞吐、峰值显存和策略表现**为主要评价。
- **方法论**：借鉴 nanoGPT 式的研究社区思路——**统一数据、训练预算和评测协议，小改动、强对照、可重复**。

> [!important] 当前研究主线
> **Can We Improve SuperMimic's Training Efficiency on a Single GPU?**
>
> 在可复现的单 GPU 基准上，能否以更低的训练成本达到与原始方法相近甚至更好的控制性能？

## 二、SuperMimic 的强化学习问题：严格定义（Goal-conditioned POMDP）

> [!important] 先给出严格结论
> **SuperMimic 不是只有 State、Action 和 Reward 的抽象 RL 问题。** 论文 Method §3.1 明确将其描述为 **目标条件化的部分可观测马尔可夫决策过程（goal-conditioned POMDP）**。MuJoCo Warp 提供仿真环境，控制策略看见的是**部分且带噪声的本体观测**；世界模型则学习仿真器的动力学以供想象 rollout 和 BPTT 使用。

### 2.1 数学定义：从 MDP 简写到完整 POMDP

为了与常见强化学习记法对应，可以先使用教学式简写：

$
\boxed{\mathcal M=(\mathcal S,\mathcal A,P,R,\mathcal O,\mathcal G,\gamma)}
$

但**这不是完整的 POMDP 定义，也不是原论文逐字给出的元组**：它没有显式写出观测生成机制、初始状态分布和终止规则。论文仅用 $\mathcal M$ 指代目标条件化 POMDP。为严谨地描述某个目标接口 $i$，本文采用以下**形式化重述**：

$
\boxed{
\mathcal M_i=
(\mathcal X,\mathcal A,\mathcal O,\mathcal G_i,
P_i,Z_i,R_i,D_i,\rho_{0,i},\gamma)
}
$

其中 $\mathcal X$ 是足以使转移满足 Markov 性的**扩展环境状态空间**；$Z_i$ 是观测核；$D_i$ 是终止规则；$\rho_{0,i}$ 是初始状态分布。$\mathcal G_i$ 是目标空间。这些符号是为了使问题定义完整而引入的，**不代表作者公开了完整的状态向量编码**。

### 2.2 逐个模块对照原论文

| 模块 | 数学符号 | SuperMimic 的具体定义 |
|---|---|---|
| **Environment** | — | MuJoCo Warp 物理仿真器中的 Unitree G1 人形机器人；接触、刚体和执行器由仿真器推进（不是实体机器人）。 |
| **State** | $s_t$ / $x_t$ | $s_t$ 是仿真器物理状态（包括机器人位置、姿态、关节坐标及速度等）；严谨的 Markov 定义可扩展成 $x_t$，还要处理参考动作进度、上一动作、环境上下文等。原论文**没有给出完整 $s_t$ 维度**。 |
| **Observation** | $o_t\in\mathcal O$ | 每帧 **93 维**本体观测：29 关节位置偏差 + 29 关节速度 + 3 基座角速度 + 3 投影重力 + 29 上一步动作。Policy 使用最近 **10 帧**。 |
| **Action** | $a_t\in\mathcal A\subseteq\mathbb R^{29}$ | **29 维连续动作**，每维控制一个关节设定点的归一化参数；经缩放和平移后输入低增益 PD 控制器，**不是直接输出关节力矩**。 |
| **Transition** | $P_i(x_{t+1}\mid x_t,a_t)$ | 扩展状态的转移；其共享物理部分由 MuJoCo Warp 的 $P_\xi^{\mathrm{phys}}(s' \mid s,a)$ 给出。世界模型学习近似 $f_\omega(s,a,\xi)$。 |
| **Goal** | $g_t\in\mathcal G_i$ | Motion Tracking：来自参考动作的目标（编码器输入未来 **10 帧**）；Velocity Tracking：目标平面速度和偏航角速度 $(v_x,v_y,\omega_z)$。 |
| **Reward** | $r_{t+1}=R_i(x_t,a_t,x_{t+1},g_t)$ | **每步计算的稠密奖励（Dense Reward）**。运动跟踪接口比较身体位置、姿态和速度，并加入动作平滑、关节限位惩罚；不同目标接口的奖励不同。 |
| **Termination** | $d_{t+1}=D_i(x_{t+1},g_{t+1})$ | Motion Tracking：相对参考动作的根节点高度误差超过 **0.25 m**，或倾斜误差超过 **0.8** 时终止；世界模型使用连续预测终止概率。 |
| **Discount** | $\gamma$ | **0.99**（论文附录训练超参数）。 |
| **Observation kernel** | $Z_i(o_t\mid x_t)$ | 无噪声本体观测加传感器噪声：$o_t=\bar o_t+\eta_t$，$\eta_t\sim\rho_\eta$。 |
| **Initial distribution** | $\rho_{0,i}$ | episode / imagined rollout 的起点分布；仿真采集可按参考动作片段与进度重置，世界模型想象则从 Replay Buffer 中的已记录状态出发。 |
| **Policy / Actor** | $\pi_{\theta,i}$ | **确定性策略**：使用观测历史与当前 Goal 输出 29 维动作。 |
| **World Model** | $f_\omega$ | **不是另一个 Policy**，而是学习的确定性可微动力学替代模型，配合奖励、观测、终止组件用于想象。 |
| **Critic** | $V_{\psi_i}$ | 估计 imagined horizon 之后的回报；每种 Goal Interface 可有自己的 Critic。 |

**概念边界：** Environment 是运行系统；$P$ 才是它在 RL 数学中对应的状态转移机制。World Model 是对这一机制的**学习近似**，不能把三者当作同一个对象。

### 2.3 为什么是 POMDP？完整 Markov State 到底是什么？

论文将 $s_t$ 作为紧凑的仿真状态记号，并未给出所有内部状态变量的逐项张量定义。严格建模时，至少需要考虑：

- **物理状态**：机器人足以决定下一时刻刚体/关节运动的状态 $s_t^{\mathrm{phys}}$；如果执行器具有内部动态，也应包含必需的内部状态。
- **仿真上下文**：每个 episode 固定的物理随机化参数 $\xi$（如摩擦、关节标定偏移、质心偏移）。未对 $\xi$ 条件化时，单独的物理状态不一定构成同一确定性转移模型。
- **任务进度**：Motion Tracking 的参考片段和时间索引 $\tau_t$，否则无法仅凭当前身体状态确定“下一帧应该模仿什么”。速度接口则需纳入当前命令及其更新规则。
- **上一动作**：动作平滑奖励和本体观测显式使用 $a_{t-1}$；要将这些机制写成只依赖当前扩展状态的函数，需要保留它。

因此，可以**概念性**地写成（并非论文直接给出的状态向量）：

$
x_t=(s_t^{\mathrm{phys}},\,\xi,\,\tau_t,\,g_t^{\mathrm{cmd}},\,a_{t-1},\,\ldots).
$

其中省略号只代表实现若存在其他影响 Markov 性的内部变量，也必须纳入；不应据此虚构实际维度。于是可以把完整环境视为扩展状态上的 MDP，而 Policy 只访问部分有噪声的观测，形成 **POMDP**。**93 维是 Observation，不是完整 State；10 帧观测历史也不保证严格恢复 Markov 性。**

### 2.4 一次状态转移：环境到底执行了什么？

设 $h_t=(o_{t-9},\ldots,o_t)$ 是控制器观察历史，$i$ 表示目标接口：

$
\begin{aligned}
g_t&\in\mathcal G_i,\qquad o_t=\bar o(x_t)+\eta_t,\\
a_t&=\pi_{\theta,i}(h_t,g_t),\quad a_t\in\mathbb R^{29},\\
a_t^{\mathrm{exec}}&=a_t+\epsilon_t
\quad\text{（仅数据采集阶段可选的动作噪声）},\\
s_{t+1}^{\mathrm{phys}}&\sim
P_\xi^{\mathrm{phys}}(\cdot\mid s_t^{\mathrm{phys}},a_t^{\mathrm{exec}}),\\
r_{t+1}&=R_i(x_t,a_t^{\mathrm{exec}},x_{t+1},g_t),\\
d_{t+1}&=D_i(x_{t+1},g_{t+1}).
\end{aligned}
$

数据采集时 Replay Buffer 记录**实际执行的带噪动作**；想象阶段使用未额外施加采集动作噪声的确定性 Policy。物理参数 $\xi$ 在 episode 内固定，观测噪声由模型外采样。这里用随机核 $P_\xi^{\mathrm{phys}}$ 是通用 RL 记法；在完整状态和仿真条件确定时，物理模拟器的转移可以是确定性的。

Action 转换与时间尺度：

$
q_t^{\mathrm{sp}}=\boldsymbol{\alpha}a_t^{\mathrm{exec}}+q^0,\qquad
\Delta t=0.02\,\mathrm{s}\quad(50\,\mathrm{Hz}).
$

MuJoCo Warp 在每个控制步内进行 **4 个 5 ms 物理子步**；$\boldsymbol\alpha$ 是逐关节动作缩放，不能未经实现核对便声称 $\mathcal A=[-1,1]^{29}$。

### 2.5 目标函数，以及多 Goal Interface 的关系

Motion Tracking 的奖励在**每个控制步**依据动作跟踪误差计算，权重、公式和终止阈值详见下文第 3.5 节。标准折扣目标可写为（论文 Method §3.1）：

$
\boxed{
J_i(\theta)=
\mathbb E\left[\sum_{t\ge0}\gamma^t c_t r_{t+1}^{(i)}\right],
\quad
c_0=1,\quad c_{t+1}=c_t(1-d_{t+1}),\quad\gamma=0.99.
}
$

这个 $J_i$ 是目标条件化的真实**模拟器**回报；论文用可微世界模型构造近似目标 $\hat J_i$，通过 $H=32$ 步 imagined rollout + Critic bootstrap + BPTT 优化 $\theta$。因此**并不是对 MuJoCo Warp 直接反传梯度**。

论文附录 *Joint training across goal interfaces* 进一步提出：每个接口 $i$ 具有自己的 $\mathcal G_i$、$R_i$、$D_i$ 和 $V_{\psi_i}$，但共享同一套物理动力学与世界模型。共享的 Policy Decoder 与接口专用 Goal Encoder 组合形成 $\pi_{\theta,i}$。训练时可以按接口分布 $p(i)$ 优化 $\mathbb E_{i\sim p}[\hat J_i(\theta)]$。

**阅读顺序**：先掌握本节的 *POMDP 定义和一次状态转移*，再读第 3 节的 *World Model、BPTT 和具体奖励函数*。这两部分刻意区分了 **“RL 问题本身”** 与 **“SuperMimic 用什么算法求解它”**。

**论文依据**：原始 TeX 的 sections/method.tex（§3.1–3.3）和 sections/appendix.tex（*Instantiation: observation, action, reward, and sim context*；*Joint training across goal interfaces*；训练超参数表）。

## 三、我们如何理解 World Model

### 3.1 从强化学习的 MDP 出发

标准 MDP 可表示为：

$$
\mathcal M=(\mathcal S,\mathcal A,P,R,\gamma)
$$

其中环境动力学的核心是状态转移：

$$
P(s_{t+1}\mid s_t,a_t)
$$

**世界模型的核心功能，就是近似环境的状态转移函数或概率分布**；更完整的世界模型还可能包含观测、奖励与终止预测。

对于 SuperMimic，我们讨论的是近似确定性的状态转移：

$$
\hat s_{t+1}=f_\omega(s_t,a_t,\xi)
$$

- $s_t$：机器人当前内部物理状态；
- $a_t$：策略输出的动作；
- $\xi$：摩擦、关节偏移等动力学条件；
- $f_\omega$：学习得到的动力学网络。

在给定完整状态、动作和环境参数的情况下，确定性模型相当于用一个点质量分布近似转移概率；它**不直接输出完整的转移概率分布**。

### 3.2 世界模型如何“学会物理”

讨论中形成的理解：SuperMimic 先通过传统物理模拟器产生状态转移样本，然后让神经网络拟合这些结果。

```text
物理模拟器（MuJoCo Warp）
   ↓ 收集 (s_t, a_t, ξ, s_{t+1}, ...)
Replay Buffer
   ↓ 抽取轨迹
World Model（多步自回归预测）
   ↓ 最小化预测损失
学到的近似动力学 fω
   ↓ imagined rollout / BPTT
Policy 优化
   ↺ 新策略再收集模拟器数据
```

物理规律在数据中的体现：

- **重力**：支撑不足时身体发生倾倒；
- **惯性**：速度与当前姿态共同影响下一状态；
- **摩擦/接触**：相同动作在不同摩擦条件下可能导致不同的滑动和支撑效果。

网络学习的是这些因素对状态转移的**综合映射**，并不意味着网络内部显式出现 $M(q)$、$G(q)$ 或“摩擦模块”。

### 3.3 多步预测比单步 MSE 更关键

讨论中提到的设置：**8 步世界模型自回归训练**；策略学习期间使用更长的 **32 步 imagined rollout**（以论文配置为参考，正式实验前复核）。

$$
\hat s_{j+1}=f_\omega(\hat s_j,a_j,\xi),\qquad \hat s_0=s_0
$$

世界模型训练不只最小化单步预测误差，还对多步状态、奖励、观测和终止信号提供监督。概念上：

$$
\mathcal L_{WM}=\sum_{j=1}^{H_{WM}}
\bigl[\mathcal L_s^{(j)}+\mathcal L_r^{(j)}+\mathcal L_o^{(j)}+\mathcal L_d^{(j)}\bigr]
$$

> [!warning] 一个核心研究风险
> **预测状态准确，不代表对动作的导数准确。** 对可微世界模型而言，
>
> $$\frac{\partial f_\omega(s_t,a_t,\xi)}{\partial a_t}$$
>
> 的质量会直接影响 BPTT 的策略更新方向。仅看 8-step state MSE 可能不足以判断世界模型好坏。

### 3.4 World Model、Policy、Critic 的区别

| 模块 | 回答的问题 | 在 SuperMimic 中的作用 |
|---|---|---|
| World Model | “执行动作之后，环境会怎样？” | 预测状态转移；提供 imagined rollout 与梯度路径 |
| Policy / Actor | “当前应该采取哪个动作？” | 生成机器人关节控制动作 |
| Critic | “从当前状态出发，未来价值如何？” | 估计未来回报，辅助策略训练 |
| Reward / Observation / Termination | “表现如何、能观察到什么、何时结束？” | 可由解析函数或预测模块实现，**不必全部是独立神经网络** |

此前对话中记录的论文网络规格（**实验前请核对源文件**）：

| 网络 | 讨论中提到的隐藏层配置 |
|---|---|
| Dynamics / World Model | MLP `(2048, 2048, 2048)` |
| Motion Encoder | MLP `(2048, 1024, 512, 256)` |
| Velocity Encoder | MLP `(256, 256)` |
| Policy / Shared Decoder | MLP `(2048, 1024, 512, 256)` |
| Critic | MLP `(256, 128)` |

Motion Encoder、Velocity Encoder、Decoder 可能属于不同控制模式/输入路径，不能未经核对就把它们解释为“始终同时运行的五个独立模型”。

### 3.5 SuperMimic 任务的论文实现细节（Reward、Termination、BPTT）

> [!info] 与第二节的关系
> 第**二**节是强化学习问题的**严格定义**，本节依据论文 Method / Appendix 进一步列出 93 维 Observation 的组成、Reward 计算与权重、具体终止条件，以及 Dyna-style 训练流程。**不要将世界模型的学习算法当作 MDP 定义的一部分。**

#### State、Observation、Goal 不能混淆

- **State**：仿真环境内部的完整动力学状态 $s_t$。它用于环境转移，也用于训练世界模型；论文没有完整列出该状态向量的确切维度，**不能把 93 维观测当成完整 State**。
- **Observation**：论文使用 $o_t=\bar o_t+\eta_t$；$\bar o_t$ 为无噪声本体观测，$\eta_t$ 是另行采样的传感器噪声。Policy 输入最近 10 帧历史 $o_{t-9:t}$，每帧维度如下：

| 单帧 Observation 组成 | 维度 |
|---|---:|
| 关节位置相对默认姿态 $q-q^0$ | 29 |
| 关节速度 $\dot q$ | 29 |
| IMU 测量的机体角速度 | 3 |
| 机体系投影重力方向 | 3 |
| 上一步动作 $a_{t-1}$ | 29 |
| **总计** | **93** |

10 帧的观测历史包含 $10\times93=930$ 个标量，但该数字**不包含**单独编码的 Goal，也不代表完整状态空间维度。使用历史观测能弥补一部分不可观测信息，却不自动使 Policy 观测本身严格 Markov。

- **Goal**：在 Motion Tracking 中，$g_t$ 来自参考动作，Motion Encoder 接收**未来 10 帧**参考运动；在 Velocity Tracking 中则是 $g_t=(v_x,v_y,\omega_z)$。**Goal 是任务条件，不是 State，也不是 Action。**

#### Action：29 维连续控制，不是离散动作标签

$$
\mathcal A\subseteq\mathbb R^{29},\qquad
 a_t=\pi_\theta(o_{t-9:t},g_t)
$$

动作按每关节的缩放系数映射为 PD 控制器的关节设定点：

$$
q_t^{\mathrm{sp}}=\boldsymbol\alpha\,a_t+q^0
$$

这里 $q^0$ 为默认姿态，$\boldsymbol\alpha$ 为每关节动作缩放。由于 PD 增益较低，这种设定点在控制效果上更接近**关节力矩的代理**，但 $a_t$ **不是直接定义为 29 维力矩向量**。动作范围的各维精确边界须以实现配置为准，不能仅凭网络输出假设为 $[-1,1]^{29}$。

控制频率为 **50 Hz**，即每 **20 ms** 给出一次动作；论文的 MuJoCo Warp 配置将一个控制步细分为 **4 个 5 ms 物理子步**。

#### Transition：MuJoCo Warp 是数据来源，World Model 是可微近似

用环境参数 $\xi$（episode 内固定的摩擦、关节标定与质心偏移）表示条件转移：

$$
 s_{t+1}\sim P(\cdot\mid s_t,a_t,\xi),\qquad
 \hat s_{t+1}=f_\omega(\hat s_t,a_t,\xi)
$$

世界模型对给定输入做**确定性预测**，不输出完整的转移概率分布；随机性中已知的来源被拆开处理：

- 采集阶段会执行带探索噪声的动作 $a_t+\epsilon_t$，其中 $\epsilon_t\sim\mathcal N(0,0.1^2)$（逐维）；Replay Buffer 记录**实际执行的带噪动作**。
- 传感器噪声 $\eta_t$ 在模型外采样；World Model 预测的是无噪声观测 $\hat{\bar o}_t$。
- 物理随机化参数 $\xi$ 作为 World Model 输入，包括地面摩擦系数 $\mu\sim\mathcal U[0.3,1.2]$、关节标定偏移和躯干质心偏移。

注意：MuJoCo Warp 是高保真**物理仿真器**，并不等于真实硬件；这里的“真实转移”仅指相对于学到的神经网络模型而言的**模拟器标签**。

#### Reward：Motion Tracking 是稠密奖励（Dense Reward）

每个控制步，都将机器人运动与参考动作比较，给出连续跟踪奖励并扣除正则惩罚：

$$
 r_{t+1}=\sum_{i\in\mathrm{tracking}}w_i r_i
 +\sum_{j\in\mathrm{penalty}}w_j p_j
$$

原论文附录的 Motion Tracking 权重：

| Reward / Penalty | 权重 |
|---|---:|
| 多身体位置跟踪 | +1.0 |
| 多身体朝向跟踪 | +1.0 |
| 多身体线速度跟踪 | +1.0 |
| 多身体角速度跟踪 | +1.0 |
| 根节点位置跟踪 | +0.5 |
| 根节点朝向跟踪 | +0.5 |
| 动作变化平滑项 $\|a_t-a_{t-1}\|^2$ | −0.1 |
| 关节限位违约惩罚 | −2.0 |

例如位置奖励（$\mathcal T$ 为被跟踪身体集合）：

$$
 r_{\mathrm{body\ pos}}=\exp\left[-\frac{\frac1{|\mathcal T|}\sum_{b\in\mathcal T}
 \lVert p_b-p_b^{\mathrm{des}}\rVert^2}{0.3^2}\right]
$$

因此即使未完成整段后空翻，机器人**每一步**仍获得平滑的动作跟踪信号。**Dense** 仅代表反馈频繁；BPTT 还依赖奖励与世界模型提供有用的局部梯度。论文的运动跟踪奖励**移除了 BeyondMimic 的自碰撞惩罚**，将关节限位惩罚权重改为 −2；奖励表中的各项还会乘控制步长 $\Delta t=0.02\,\mathrm{s}$。

Velocity Tracking 是另一个任务接口：主要奖励为平面线速度和偏航角速度跟踪，并采用其自身的正则项和摔倒终止条件；**不能把 Motion Tracking 奖励表机械套用到全部 Goal Interface。**

#### Termination、Critic 与有限时域目标

对 **Motion Tracking**，当机器人根节点相对参考姿态的高度误差 $|e_{p,z}|>0.25\,\mathrm m$，或倾斜误差 $e_{\mathrm{tilt}}>0.8$ 时，模拟器硬终止；这里的 0.8 是**重力方向投影定义的倾斜误差**，不是 0.8 弧度。World Model 中预测连续终止概率 $\hat d_t\in[0,1]$，使存活权重可微：

$$
\hat c_0=1,\qquad \hat c_{t+1}=\hat c_t(1-\hat d_{t+1})
$$

BPTT 优化的 imagined return（$H=32$，$\gamma=0.99$）为：

$$
\hat J(\theta)=\mathbb E\!\left[
 \sum_{t=0}^{H-1}\gamma^t\hat c_t\hat r_{t+1}
 +\gamma^H\hat c_H V_\psi(\hat s_H,g_H,\xi)
\right]
$$

Critic 不是环境本身的状态转移模型；它学习估计**世界模型只展开 32 步之后的长期回报**。论文使用 imagined transitions 上计算的 GAE 目标拟合 Critic；多 Goal Interface 情况下每个接口拥有自己的 Critic。

#### 一轮完整交互：为什么属于 Dyna-style Model-Based RL

```text
目标 g_t + 观测历史 o_{t-9:t}
              │
              ▼
       Policy πθ → 29 维动作 a_t
              │ 采集阶段加入动作噪声 ε_t
              ▼
       MuJoCo Warp 环境
              │
              ▼
   物理转移、奖励、观测、终止
              │
              ▼
         Replay Buffer
             ┌┴────────────────────────┐
             ▼                         ▼
     [A] World Model               [B] Policy / Critic
     8 步自回归拟合                 从 Buffer 状态起步
     更新模型参数 ω                 通过冻结权重的 WM 想象 32 步
                                   BPTT 更新 θ + GAE 训练 ψ
                                           │
                                           ▼
                                  新策略返回 MuJoCo Warp
```

这里“冻结 World Model”是指**Policy 更新阶段不更新 $\omega$**，而不是阻断对模型输入（状态、动作）的梯度。真实仿真与模型想象**并不共同逐步推进同一条轨迹**；两者通过 Buffer 和交替训练形成闭环。

> [!important] 与 PPO / Sparse Reward 的对照
> **PPO** 可以将未来最终 Reward 用于更新之前动作的概率，即使环境不可微；**SuperMimic BPTT** 则利用 $\partial f_\omega/\partial a$ 将未来奖励沿连续动力学直接反传回 Policy。两者都在处理信用分配，但梯度估计途径不同；本文的**连续 Action + Dense Reward + 可微 World Model** 组合尤其有利于后者。把这套思路迁移到离散 Token、稀疏成功奖励的 LLM Agent 时，不能假定 BPTT 优势会自动保留。

**原文依据**：`sections/method.tex`（§3.1–3.3 与图 2），`sections/appendix.tex`（Instantiation: observation, action, reward, and sim context；Joint training across goal interfaces；Network architectures；Training loop and hyperparameters）。

## 四、Model-Based RL 与 Model-Free RL 的厘清

我们的核心判断：**“使用模拟器训练”不等于 “Model-Based RL”。**

| 训练方式 | 是否学习或使用状态转移模型来优化决策 | 归类 |
|---|---|---|
| 在 MuJoCo 中采样，然后 PPO 更新 | 不需要显式学习模型 | Model-Free RL |
| 学习 $\hat P(s'\mid s,a)$，用它生成 imagined rollouts 再 PPO | 使用学习到的模型 | Model-Based RL |
| 学习可微 $f_\omega$，通过 BPTT 优化策略 | 使用模型及其梯度 | Model-Based RL |

- **SONIC**：对话中核对的主要方法是基于物理仿真采样与 PPO 的 **Model-Free RL**。
- **BeyondMimic**：其主要控制学习阶段使用 PPO；**不能因此推断所有 SuperMimic 作者以前从未做过 Model-Based RL**。
- **SuperMimic**：通过学习到的可微世界模型进行策略优化；其新意不是“第一次把 MBRL 用于机器人”，而是大规模人形全身动作的训练效率与性能。
- **PPO-WM 消融**：即使用世界模型生成 imagined trajectories、但仍用 PPO 更新，也属于使用世界模型的 Model-Based RL；区别在于是否直接利用动力学梯度。

## 五、与 LLM RL 的思想联系（暂不展开实验）

### 5.1 为什么普通 LLM RL post-training 通常是 Model-Free

对纯文本逐 token 生成，可以将：

$$
s_t=(x,y_{<t}),\quad a_t=y_t,\quad s_{t+1}=s_t\oplus a_t
$$

理解为一个简单的交互过程。此时状态转移本身就是拼接 token；LLM 主要参数化的是动作分布：

$$
\pi_\theta(a_t\mid s_t)
$$

而不是给定动作后的外部环境转移模型 $P(s_{t+1}\mid s_t,a_t)$。因此，常规 PPO / GRPO 在这种设置下仍属于 Model-Free RL。

### 5.2 一个值得保留的观点：Policy 内部可能包含隐式 World Model

我们并不认为 **Reward Model = World Model**。更有启发的假设是：

> **预训练 Policy 可能已经通过 next-token prediction 学会大量世界规律；同一个模型能否同时充当 Actor 和 Environment Predictor？**

需区分两件事：

1. Policy **内部具有某种世界表示或预测能力**；
2. RL 算法 **显式利用这种能力模拟动作后果并优化决策**。

前者不自动使 PPO/GRPO 成为 Model-Based RL。对于工具交互式 Agent，同一 Transformer 可以理论上通过不同条件化模式预测动作 $a_t$ 与环境观测 $o_{t+1}$，但要处理预测不确定性、模型与真实观测的区分等问题。

**决定：** 这条路线作为未来灵感记录，**不在当前单 GPU 研究阶段执行 LLM 实验**。

## 六、最想探索的长期方向：World Model 与 Policy 融合

### 6.1 目标要分成两个不同问题

**A. 网络架构融合（Model Unification）**

将 World Model、Policy（以及可能的 Critic）共享一部分状态表示，减少重复建模与计算。

**B. 训练过程融合（Joint / End-to-End Optimization）**

让动力学学习与策略优化彼此促进，而不是只通过交替训练连接。

> [!tip] 关键澄清
> SuperMimic **已经让策略梯度穿过冻结参数的 World Model，端到端传回 Policy**。我们希望探索的下一步，是**共享参数、共享表征或更紧密的联合优化**，不是简单地“第一次实现梯度穿越 World Model”。

### 6.2 候选的 Unified Dynamics–Policy Network

```text
训练时可用的状态 / 动力学参数 ξ      部署时可用的本体观测 / 运动目标
              │                                 │
              └──── 条件化 / 分支编码 ───────────┘
                                ↓
                     Shared Latent Encoder
                                ↓
                   ┌────────────┼───────────┐
                   ↓            ↓           ↓
              Dynamics Head  Policy Head  Value Head
                   │            │           │
              预测未来状态    生成控制动作   估计价值
```

只是**候选架构草图**，不是论文现有结构。必要时可以共享部分 trunk，而将动力学所需的 privileged state 和部署时的 observation 分开处理。

### 6.3 为什么“合成一个模型”不等于“更好”

- **Model Exploitation**：如果 RL 奖励梯度直接更新动力学网络，模型可能虚构有利于高回报但不真实的状态轨迹。
- **目标冲突**：精确状态预测与有利于控制的特征提取不一定完全一致。
- **信息泄漏**：模拟器完整状态/环境参数未必能在真实机器人部署时获得。
- **计算不一定下降**：共享网络可能减少参数，但增加训练时反向传播成本，甚至增加在线 Policy 推理负担。
- **准确性不等于梯度质量**：需要对策略回报而不是纯预测 MSE 负责。

所以第一版不宜直接用 RL loss 无约束地更新所有动力学参数。更合理的是先做**部分表示共享 + 物理监督 + 明确的梯度隔离**，再逐步放宽。

### 6.4 更深层的研究问题

**世界模型一定要完整重建所有物理状态吗？**

或者说，能否只学习对策略决策、稳定性及 BPTT 梯度真正重要的部分？

这可以引出 **Task-Aware Latent Dynamics**：

$$
z_t=E_\phi(s_t),\qquad \hat z_{t+1}=F_\omega(z_t,a_t)
$$

再由统一表示服务策略与价值估计。但要额外评估低维 latent 是否丢失接触/稳定性相关信息，以及训练时与部署时观测的不一致。

## 七、单 GPU 研究路线与实验计划

> [!success] 实施原则
> **一个实验只改动一个主要变量**。每次固定数据、训练预算、评测动作、随机种子和硬件条件；为 Colab 的中断保存 checkpoint 与实验日志。

### P0 — 建立可信、可运行的基准（当前唯一必须优先完成的任务）

- [ ] 确定具体社区实现及 commit，记录许可证与和论文的差异。
- [ ] 在 Colab 中记录 GPU 型号、显存、CUDA/PyTorch、运行时与依赖版本。
- [ ] 检查是否能安装 MuJoCo Warp / mjlab（必要时优先验证最小环境）。
- [ ] 先在少量 LAFAN1 motion 上跑通 **Simulator → Replay Buffer → WM → imagined rollout → Policy/Critic**。
- [ ] 保存 checkpoint、训练日志、曲线、运行配置和评测脚本。
- [ ] 至少重复一次，判断结果和运行时间是否稳定。
- [ ] 为“无法在 Colab 跑通完整仿真”预备降级方案：仅用保存的状态转移轨迹进行 **离线 WM 研究**（不可宣称完成了控制算法复现）。

**P0 交付物**：一个可从干净 Colab 环境运行的 Notebook / 脚本 + 一份 baseline 数字与复现说明。

### P1 — Smaller World Model

在尽量保持其他条件一致的前提下，对照：

| 实验 | WM 隐藏层 | 目标 |
|---|---|---|
| Baseline | `(2048, 2048, 2048)` | 参照实现 |
| A | `(1024, 1024, 1024)` | 评估中等压缩 |
| B | `(512, 512, 512)` | 评估显著压缩 |
| C | `(256, 256, 256)` | 探索容量下限 |

**主要问题**：多步预测稍差的 WM，是否可能因为计算更轻而让 Policy 更快达到目标表现？

### P2 — Adaptive Imagination Horizon

以固定 rollout horizon $H\in\{8,16,32\}$ 为对照，再研究：

$$
H_t=g(\text{估计的预测不确定性},\text{运动状态})
$$

直觉：稳定动作时允许更长的预测；接触、落地、强非线性等不确定性较高的时刻缩短 horizon，并由 Critic 补足较远期价值。

**待解决问题**：训练时真实 future state 并不可得，不能直接把真实模型误差作为自适应 horizon 的在线输入；需要建立可用的误差/不确定性代理。

### P3 — Unified World Model + Policy（长期重点）

建议做逐级对照：

1. **Separated**：原始独立 WM / Actor / Critic。
2. **Partially Shared**：共享一部分 encoder / representation，保留独立预测与控制 head。
3. **Constrained Joint**：保留物理监督，通过受约束的多任务目标联合更新一部分参数。

需要单独测试：**共享参数究竟省下多少计算；是否发生 model exploitation；是否影响真实动力学预测和最终控制能力。**

### P4 — Task-Aware Dynamics / Gradient-Aware World Model

更进一步的问题：与其单独降低状态预测 MSE，能否让世界模型学习对 Policy 更有用的动力学梯度？

候选研究点：

- 动作 Jacobian 的一致性或梯度方向评估；
- 带物理先验的残差动力学；
- 任务感知 latent dynamics；
- 根据接触状态分段建模或调节 rollout；
- 受约束的 WM/Policy 联合训练。

这些是**假设**，不是已经成立的创新或实验结果。

## 八、评价指标与实验规范

| 维度 | 应记录的指标 | 为什么 |
|---|---|---|
| World Model 准确率 | 单步 / 8 步 / 32 步预测误差（按状态子集细分） | 衡量多步误差积累 |
| 控制能力 | normalized return、动作跟踪误差、成功率与失败率 | 判断算法是否真的有效 |
| 训练效率 | **达到同一目标回报的 GPU-hours / wall-clock time** | 核心研究目标 |
| 计算瓶颈 | Simulation / WM training / BPTT / Critic 的分阶段耗时 | 决定优化优先级 |
| 资源占用 | 峰值 GPU 显存、吞吐、OOM 与稳定性 | 保证单卡可运行 |
| 可重复性 | seed、commit、参数、数据切分、checkpoint | 避免单次偶然现象 |
| 梯度质量 | WM action Jacobian 与物理/有限差分参考的偏差（若可行） | 验证“预测准确但梯度不准确”的问题 |

> [!warning] 公平比较
> 不能将缩减并行环境数、缩短 horizon 后得到的 return 与论文原始 H100 大规模配置直接当成同等条件的 SOTA 对比。**先在我们自己的相同条件下建立 baseline，再比较算法改动。**

## 九、悬而未决的问题

- [ ] 哪个社区实现最接近论文？是否能证明其超参数、损失函数与更新逻辑一致？
- [ ] 原始 2048×3 动力学模型的输入/输出维度、激活函数、残差形式和状态归一化究竟如何定义？
- [ ] Colab 实际分配的 GPU 能否支持完整 MuJoCo Warp 并行仿真与 BPTT？
- [ ] 8-step 训练误差与 32-step rollout 控制性能之间的关系是否稳定？
- [ ] World Model 的哪些状态变量（如接触相关变量）真正决定 Policy 性能？
- [ ] 对 Jacobian 质量进行约束，是否比单纯增大 MLP 更有效？
- [ ] 部分共享表示会不会导致 privileged state 泄漏到部署 Policy？
- [ ] **联合训练究竟能减少 GPU-hours，还是只减少网络数量？**

## 十、研究资料

**论文 / 源码**

- [SuperMimic — arXiv 2610.28480](https://arxiv.org/abs/2610.28480)
- [SuperMimic — 原始 TeX 源码](https://arxiv.org/src/2610.28480)
- [SONIC — arXiv 2511.07820](https://arxiv.org/abs/2511.07820)

**社区实现（使用前核对 commit、环境和许可）**

- [zita-ch/supermimic_vibed](https://github.com/zita-ch/supermimic_vibed)
- [YHFone/supermimic-mjlab](https://github.com/YHFone/supermimic-mjlab)

**参考范式**

- [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT) —— 启发我们构建简单、统一、以实测为中心的算法基准。
- 可延伸阅读：ControlVAE、TD-MPC2、Dreamer 系列、PWM 等；**阅读不等于当前启动实验**。

## 十一、下一步的最小行动

**唯一近期目标：完成 P0。**

1. 选择一个能在 Colab 中实际运行的 SuperMimic 实现，固定 commit。
2. 写出最小安装与运行流程，测量单步仿真、WM 更新、BPTT 的耗时与显存。
3. 在少量动作上跑通训练，产出**首条可信的 baseline 回报曲线**。
4. 保存完整环境与实验配置，然后才开展 P1 缩小世界模型实验。

之后可将每次实验记录在 `[[SuperMimic - 实验日志]]`（Obsidian 内部链接占位，需要时再创建）中。

---

> [!quote] 这次讨论最终收敛到的研究问题
> **World Model 真的需要预测全部物理状态吗？能否通过更紧密地结合 Policy，学到更小、更高效、梯度更可靠的任务感知动力学模型？**
>
> 我们不急于得到答案。先从一张 GPU、一个可信基准、一项可验证的改动开始。