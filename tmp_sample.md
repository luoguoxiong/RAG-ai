# Qdrant 向量检索

Qdrant 是一个高性能的开源向量数据库，用于相似度搜索。

它支持余弦相似度、欧氏距离等距离度量方式。

每个租户可以使用独立的 collection 实现数据隔离。

## Parent-Child 切分

Parent-Child 切分策略将文档切分为较大的父块和较小的子块。

子块用于向量检索以提高精度，父块提供完整上下文。

这种策略平衡了检索的精准度与上下文的完整性。

## 多租户隔离

系统通过 PostgreSQL 的 Row-Level Security 实现租户隔离。

每个表都带有 tenant_id 字段，RLS 策略强制过滤数据。